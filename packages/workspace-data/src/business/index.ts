import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { BusinessAnalysis, BusinessAnalysisRequest, BusinessAnalyticalResult, BusinessDimension, BusinessFilterField, BusinessMeasure, BusinessPresentationIntent, BusinessTimePreset } from '@pi-workbench/contracts';
import scenarioSnapshot from '../business-scenarios.json' with { type: 'json' };
import { businessCatalog, dimensionCatalog, dimensionField, filterValues, measureCatalog, measureField } from './catalog.js';
import { planBusinessPresentation } from './presentation-planner.js';

type Row = Record<string, unknown>;

const datasetName = '电商经营演示数据' as const;
const seedEndDate = '2026-08-18';
const seedDays = 365;
const seedVersion = `${businessCatalog.version}:${scenarioSnapshot.generatedAt}`;
const presentationIntents = new Set<BusinessPresentationIntent>(['auto', 'trend', 'comparison', 'ranking', 'detail']);
const timePresets = new Set<BusinessTimePreset>(['last_7_days', 'last_30_days', 'last_90_days', 'all']);

if (scenarioSnapshot.model !== 'gpt-5.6-luna' || scenarioSnapshot.concurrency !== 20 || scenarioSnapshot.scenarios.length !== 20) {
  throw new Error('Luna business scenario snapshot is incomplete');
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return isoDate(date);
}

function timeWindow(preset: BusinessTimePreset, asOf: string): { from: string; to: string } {
  const days = preset === 'last_7_days' ? 7 : preset === 'last_30_days' ? 30 : preset === 'last_90_days' ? 90 : seedDays;
  return { from: addDays(asOf, -(days - 1)), to: addDays(asOf, 1) };
}

function uniqueCatalogKeys<T extends string>(values: readonly string[], catalog: Record<T, unknown>, label: string, maximum: number): T[] {
  const unique = [...new Set(values)];
  if (!unique.length && label === '指标') throw new Error('至少需要一个认证指标');
  if (unique.length > maximum) throw new Error(`${label}最多允许 ${maximum} 个`);
  for (const value of unique) if (!(value in catalog)) throw new Error(`不支持的${label}：${value}`);
  return unique as T[];
}

function normalizeRequest(input: BusinessAnalysisRequest): BusinessAnalyticalResult['request'] {
  const measures = uniqueCatalogKeys<BusinessMeasure>(input.measures ?? [], measureCatalog, '指标', businessCatalog.limits.maxMeasures);
  const dimensions = uniqueCatalogKeys<BusinessDimension>(input.dimensions, dimensionCatalog, '维度', businessCatalog.limits.maxDimensions);
  const preset = input.time?.preset ?? 'last_30_days';
  if (!timePresets.has(preset)) throw new Error(`不支持的时间范围：${preset}`);
  const presentationIntent = input.presentationIntent ?? 'auto';
  if (!presentationIntents.has(presentationIntent)) throw new Error(`不支持的展示意图：${presentationIntent}`);
  if ((input.filters?.length ?? 0) > businessCatalog.limits.maxFilters) throw new Error(`筛选条件最多允许 ${businessCatalog.limits.maxFilters} 个`);
  const filters = (input.filters ?? []).map((filter) => {
    if (!(filter.field in filterValues)) throw new Error(`不支持的筛选字段：${filter.field}`);
    if (filter.operator !== 'eq' && filter.operator !== 'in') throw new Error(`不支持的筛选操作符：${String(filter.operator)}`);
    const values = [...new Set(filter.values.map((value) => value.trim()).filter(Boolean))];
    if (!values.length) throw new Error(`${filter.field} 至少需要一个筛选值`);
    if (filter.operator === 'eq' && values.length !== 1) throw new Error(`${filter.field} 的 eq 筛选只能包含一个值`);
    const allowed = filterValues[filter.field as BusinessFilterField];
    for (const value of values) if (!allowed.includes(value)) throw new Error(`${filter.field} 不支持筛选值：${value}`);
    return { field: filter.field, operator: filter.operator, values };
  });
  if (input.sort && (!measures.includes(input.sort.field) || !['asc', 'desc'].includes(input.sort.direction))) throw new Error('排序字段必须是当前查询中的认证指标');
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 20), 1), businessCatalog.limits.maxRows);
  return { measures, dimensions, time: { preset }, filters, ...(input.sort ? { sort: input.sort } : {}), limit, presentationIntent };
}

function scenarioForDate(saleDate: string) {
  const scenario = scenarioSnapshot.scenarios.find((item) => saleDate >= item.from && saleDate <= item.to);
  if (!scenario) throw new Error(`没有覆盖 ${saleDate} 的 Luna 经营场景`);
  return scenario;
}

function seedRows(db: DatabaseSync) {
  const regions = filterValues.region;
  const channels = filterValues.channel;
  const categories = filterValues.category;
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
            const lunaWeight = (scenario.regionWeights as Record<string, number>)[regionName]! * (scenario.channelWeights as Record<string, number>)[channelName]! * (scenario.categoryWeights as Record<string, number>)[categoryName]! * scenario.monthWeights[month]!;
            const orders = Math.max(1, Math.round(baseOrders * growth / 100 * lunaWeight));
            const seasonal = 94 + (day % 14);
            const grossCents = Math.round(orders * unitPrices[category]! * seasonal / 100 * (anomaly?.salesMultiplier ?? 1));
            const refundBps = Math.max(0, categoryRefundBps[category]! + channelRefundBps[channel]! + (scenario.refundAdjustmentsBps as Record<string, number>)[categoryName]! + (anomaly?.refundBpsDelta ?? 0) + ((day + region + category) % 5) * 18);
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
  readonly catalog = businessCatalog;
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

  analyze(input: BusinessAnalysisRequest): BusinessAnalysis {
    const request = normalizeRequest(input);
    const asOf = String((this.db.prepare('SELECT MAX(sale_date) AS value FROM business_sales_daily').get() as Row).value ?? seedEndDate);
    const coverageRow = this.db.prepare('SELECT MIN(sale_date) AS min_date, MAX(sale_date) AS max_date, COUNT(*) AS count FROM business_sales_daily').get() as Row;
    const window = timeWindow(request.time.preset, asOf);
    const where = ['sale_date >= ?', 'sale_date < ?'];
    const params: Array<string | number> = [window.from, window.to];

    for (const filter of request.filters) {
      const sql = dimensionCatalog[filter.field].sql;
      where.push(`${sql} IN (${filter.values.map(() => '?').join(', ')})`);
      params.push(...filter.values);
    }

    const selectedDimensions = request.dimensions.map((key) => `${dimensionCatalog[key].sql} AS "${key}"`);
    const selectedMeasures = request.measures.map((key) => `${measureCatalog[key].sql} AS "${key}"`);
    const groupExpressions = request.dimensions.map((key) => dimensionCatalog[key].sql);
    const defaultSort = request.dimensions.find((key) => dimensionCatalog[key].role === 'time');
    const orderClause = request.sort ? `"${request.sort.field}" ${request.sort.direction.toUpperCase()}` : defaultSort ? `"${defaultSort}" ASC` : `"${request.measures[0]}" DESC`;
    const select = [...selectedDimensions, ...selectedMeasures].join(', ');
    const groupBy = groupExpressions.length ? ` GROUP BY ${groupExpressions.join(', ')}` : '';
    const stableDimensions = request.dimensions.map((key) => `"${key}" ASC`).join(', ');
    const sql = `SELECT ${select} FROM business_sales_daily WHERE ${where.join(' AND ')}${groupBy} ORDER BY ${orderClause}${stableDimensions ? `, ${stableDimensions}` : ''} LIMIT ?`;
    const rows = this.db.prepare(sql).all(...params, request.limit) as Row[];
    const result: BusinessAnalyticalResult = {
      queryId: `business_${randomUUID().slice(0, 8)}`,
      catalogVersion: businessCatalog.version,
      dataset: datasetName,
      request,
      fields: [...request.dimensions.map(dimensionField), ...request.measures.map(measureField)],
      rows: rows.map((row) => Object.fromEntries(Object.entries(row).filter(([, value]) => typeof value === 'string' || typeof value === 'number')) as Record<string, string | number>),
      metadata: {
        asOf,
        datasetRows: Number(coverageRow.count ?? 0),
        coverage: { from: String(coverageRow.min_date ?? ''), to: String(coverageRow.max_date ?? '') },
        generation: { source: 'codex-cli', model: 'gpt-5.6-luna', concurrency: 20, scenarios: 20 },
        timeWindow: { ...window, timezone: 'Asia/Shanghai' },
        rowCount: rows.length,
        freshness: `演示数据更新至 ${asOf} 23:59（Asia/Shanghai）`,
        limitations: ['这是确定性演示数据，不代表真实生产经营结果。', '查询仅支持认证指标、维度和枚举筛选，不接受 SQL。'],
      },
    };
    return { result, presentation: planBusinessPresentation(result) };
  }

  close() {
    this.db.close();
  }
}

export { businessCatalog } from './catalog.js';
export { planBusinessPresentation } from './presentation-planner.js';
export const businessDataStore = new SqliteBusinessDataStore();
