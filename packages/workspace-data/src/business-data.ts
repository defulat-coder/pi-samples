import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BusinessDimension, BusinessMetric, BusinessPeriod, BusinessQueryRequest, BusinessQueryResult } from '@pi-workbench/contracts';
import scenarioSnapshot from './business-scenarios.json' with { type: 'json' };

type Row = Record<string, unknown>;

const catalogVersion = 'sales-demo-v2' as const;
const datasetName = '电商经营演示数据' as const;
const seedEndDate = '2026-08-18';
const seedDays = 365;
const seedVersion = `${catalogVersion}:${scenarioSnapshot.generatedAt}`;

const regions = ['华东', '华南', '华北', '华中', '西部', '东北'] as const;
const channels = ['直营网店', '平台电商', '直播', '内容电商'] as const;
const categories = ['数码家电', '家居生活', '美妆个护', '食品饮料', '服饰鞋包', '运动户外'] as const;

if (scenarioSnapshot.model !== 'gpt-5.6-luna' || scenarioSnapshot.concurrency !== 20 || scenarioSnapshot.scenarios.length !== 20) {
  throw new Error('Luna business scenario snapshot is incomplete');
}

const metricDefinitions: Record<BusinessMetric, { name: string; unit: '元' | '单' | '%'; definition: string; formula: string; owner: string; sql: string; alias: string }> = {
  gross_sales: { name: 'GMV', unit: '元', definition: '已支付订单在退款前的商品成交总额。', formula: 'SUM(gross_sales_cents) / 100', owner: '经营分析组', sql: 'ROUND(SUM(gross_sales_cents) / 100.0, 2)', alias: 'grossSales' },
  net_sales: { name: '退款后销售额', unit: '元', definition: 'GMV 扣除已记录退款金额后的经营销售额，不等同于会计营收。', formula: 'SUM(gross_sales_cents - refund_cents) / 100', owner: '经营分析组', sql: 'ROUND(SUM(gross_sales_cents - refund_cents) / 100.0, 2)', alias: 'netSales' },
  order_count: { name: '支付订单量', unit: '单', definition: '完成支付的订单数量。', formula: 'SUM(order_count)', owner: '交易产品组', sql: 'SUM(order_count)', alias: 'orderCount' },
  average_order_value: { name: '退款后客单价', unit: '元', definition: '退款后销售额除以支付订单量。', formula: 'SUM(gross_sales_cents - refund_cents) / 100 / SUM(order_count)', owner: '经营分析组', sql: 'ROUND(SUM(gross_sales_cents - refund_cents) / 100.0 / NULLIF(SUM(order_count), 0), 2)', alias: 'averageOrderValue' },
  refund_rate: { name: '退款率', unit: '%', definition: '已记录退款金额占 GMV 的比例。', formula: 'SUM(refund_cents) / SUM(gross_sales_cents) * 100', owner: '售后运营组', sql: 'ROUND(SUM(refund_cents) * 100.0 / NULLIF(SUM(gross_sales_cents), 0), 2)', alias: 'refundRate' },
};

const dimensionSql: Record<BusinessDimension, string> = {
  none: "'全部'",
  region: 'region',
  channel: 'channel',
  category: 'category',
  month: "substr(sale_date, 1, 7)",
};

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

function timeWindow(period: BusinessPeriod, asOf: string): { from: string; to: string } {
  const days = period === 'last_7_days' ? 7 : period === 'last_30_days' ? 30 : period === 'last_90_days' ? 90 : seedDays;
  return { from: addDays(asOf, -(days - 1)), to: addDays(asOf, 1) };
}

function uniqueMetrics(metrics: BusinessMetric[]): BusinessMetric[] {
  const result = [...new Set(metrics)].filter((metric): metric is BusinessMetric => metric in metricDefinitions);
  if (!result.length) throw new Error('至少需要一个受支持的业务指标');
  return result.slice(0, 3);
}

function scenarioForDate(saleDate: string) {
  const scenario = scenarioSnapshot.scenarios.find((item) => saleDate >= item.from && saleDate <= item.to);
  if (!scenario) throw new Error(`没有覆盖 ${saleDate} 的 Luna 经营场景`);
  return scenario;
}

function seedRows(db: DatabaseSync) {
  const expectedRows = seedDays * regions.length * channels.length * categories.length;
  const existing = Number((db.prepare('SELECT COUNT(*) AS count FROM business_sales_daily').get() as Row).count ?? 0);
  const currentVersion = String((db.prepare("SELECT value FROM business_seed_metadata WHERE key = 'version'").get() as Row | undefined)?.value ?? '');
  if (currentVersion === seedVersion && existing === expectedRows) return;

  const insert = db.prepare('INSERT INTO business_sales_daily (sale_date, region, channel, category, order_count, gross_sales_cents, refund_cents) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const unitPrices = [168_800, 36_800, 28_800, 12_800, 49_800, 68_800];
  const categoryRefundBps = [420, 360, 760, 280, 520, 430];
  const channelRefundBps = [0, 120, 310, 180];

  db.exec('BEGIN');
  try {
    db.exec('DELETE FROM business_sales_daily');
    for (let day = 0; day < seedDays; day += 1) {
      const saleDate = addDays(seedEndDate, -(seedDays - day - 1));
      const month = new Date(`${saleDate}T00:00:00.000Z`).getUTCMonth();
      const growth = 82 + Math.round(day * 28 / (seedDays - 1));
      const scenario = scenarioForDate(saleDate);
      for (let region = 0; region < regions.length; region += 1) {
        for (let channel = 0; channel < channels.length; channel += 1) {
          for (let category = 0; category < categories.length; category += 1) {
            const baseOrders = 24 + region * 2 + channel * 3 + category * 2 + ((day * 7 + region * 3 + channel * 5 + category * 11) % 17);
            const regionName = regions[region]!;
            const channelName = channels[channel]!;
            const categoryName = categories[category]!;
            const anomaly = scenario.anomalies.find((item) => item.month === month + 1 && item.region === regionName && item.channel === channelName && item.category === categoryName);
            const lunaWeight = scenario.regionWeights[regionName] * scenario.channelWeights[channelName] * scenario.categoryWeights[categoryName] * scenario.monthWeights[month]!;
            const orders = Math.max(1, Math.round(baseOrders * growth / 100 * lunaWeight));
            const seasonal = 94 + (day % 14);
            const grossCents = Math.round(orders * unitPrices[category]! * seasonal / 100 * (anomaly?.salesMultiplier ?? 1));
            const refundBps = Math.max(0, categoryRefundBps[category]! + channelRefundBps[channel]! + scenario.refundAdjustmentsBps[categoryName] + (anomaly?.refundBpsDelta ?? 0) + ((day + region + category) % 5) * 18);
            const refundCents = Math.round(grossCents * refundBps / 10_000);
            insert.run(saleDate, regionName, channelName, categoryName, orders, grossCents, refundCents);
          }
        }
      }
    }
    db.prepare("INSERT OR REPLACE INTO business_seed_metadata (key, value) VALUES ('version', ?)").run(seedVersion);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export class SqliteBusinessDataStore {
  readonly dbPath: string;
  private readonly db: DatabaseSync;

  constructor(dbPath = process.env.PI_BUSINESS_DB_PATH ?? resolve(process.cwd(), '.data/pi-business.sqlite')) {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS business_sales_daily (
        sale_date TEXT NOT NULL,
        region TEXT NOT NULL,
        channel TEXT NOT NULL,
        category TEXT NOT NULL,
        order_count INTEGER NOT NULL,
        gross_sales_cents INTEGER NOT NULL,
        refund_cents INTEGER NOT NULL,
        PRIMARY KEY (sale_date, region, channel, category)
      );
      CREATE TABLE IF NOT EXISTS business_seed_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_business_sales_date ON business_sales_daily(sale_date);
      CREATE INDEX IF NOT EXISTS idx_business_sales_region ON business_sales_daily(region);
      CREATE INDEX IF NOT EXISTS idx_business_sales_channel ON business_sales_daily(channel);
      CREATE INDEX IF NOT EXISTS idx_business_sales_category ON business_sales_daily(category);
    `);
    seedRows(this.db);
  }

  query(input: BusinessQueryRequest): BusinessQueryResult {
    const metrics = uniqueMetrics(input.metrics);
    const groupBy = input.groupBy && input.groupBy in dimensionSql ? input.groupBy : 'none';
    const period = input.period ?? 'last_30_days';
    const orderBy = input.orderBy && metrics.includes(input.orderBy) ? input.orderBy : metrics[0]!;
    const order = input.order === 'asc' ? 'asc' : 'desc';
    const limit = Math.min(Math.max(Math.trunc(input.limit ?? 10), 1), 20);
    const asOf = String((this.db.prepare('SELECT MAX(sale_date) AS value FROM business_sales_daily').get() as Row).value ?? seedEndDate);
    const coverageRow = this.db.prepare('SELECT MIN(sale_date) AS min_date, MAX(sale_date) AS max_date, COUNT(*) AS count FROM business_sales_daily').get() as Row;
    const window = timeWindow(period, asOf);
    const where = ['sale_date >= ?', 'sale_date < ?'];
    const params: Array<string | number> = [window.from, window.to];

    if (input.region) { where.push('region = ?'); params.push(input.region); }
    if (input.channel) { where.push('channel = ?'); params.push(input.channel); }
    if (input.category) { where.push('category = ?'); params.push(input.category); }

    const selectedMetrics = metrics.map((metric) => `${metricDefinitions[metric].sql} AS ${metricDefinitions[metric].alias}`);
    const groupExpression = dimensionSql[groupBy];
    const orderAlias = metricDefinitions[orderBy].alias;
    const orderExpression = groupBy === 'month' ? 'dimension' : orderAlias;
    const sql = `SELECT ${groupExpression} AS dimension, ${selectedMetrics.join(', ')} FROM business_sales_daily WHERE ${where.join(' AND ')}${groupBy === 'none' ? '' : ` GROUP BY ${groupExpression}`} ORDER BY ${orderExpression} ${order.toUpperCase()}, dimension ASC LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, limit) as Row[];

    return {
      queryId: `business_${randomUUID().slice(0, 8)}`,
      catalogVersion,
      dataset: datasetName,
      asOf,
      datasetRows: Number(coverageRow.count ?? 0),
      coverage: { from: String(coverageRow.min_date ?? ''), to: String(coverageRow.max_date ?? '') },
      generation: { source: 'codex-cli', model: 'gpt-5.6-luna', concurrency: 20, scenarios: 20 },
      timeWindow: { ...window, timezone: 'Asia/Shanghai' },
      query: { metrics, groupBy, period, orderBy, order, limit, ...(input.region ? { region: input.region } : {}), ...(input.channel ? { channel: input.channel } : {}), ...(input.category ? { category: input.category } : {}) },
      metricDefinitions: metrics.map((id) => ({ id, name: metricDefinitions[id].name, unit: metricDefinitions[id].unit, definition: metricDefinitions[id].definition, formula: metricDefinitions[id].formula, owner: metricDefinitions[id].owner, grain: '日', timeField: 'sale_date' })),
      rows: rows.map((row) => Object.fromEntries(Object.entries(row).filter(([, value]) => typeof value === 'string' || typeof value === 'number')) as Record<string, string | number>),
      rowCount: rows.length,
      freshness: `演示数据更新至 ${asOf} 23:59（Asia/Shanghai）`,
      limitations: ['这是确定性演示数据，不代表真实生产经营结果。', '查询仅支持认证指标、维度和精确枚举过滤，不接受 SQL。'],
    };
  }

  close() {
    this.db.close();
  }
}

export const businessDataStore = new SqliteBusinessDataStore();
