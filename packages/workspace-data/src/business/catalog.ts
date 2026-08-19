import type { BusinessAnalyticalField, BusinessCatalogSummary, BusinessDimension, BusinessFilterField, BusinessMeasure } from '@pi-workbench/contracts';

type MeasureDefinition = Omit<BusinessAnalyticalField, 'key' | 'role' | 'dataType'> & { sql: string };
type DimensionDefinition = Omit<BusinessAnalyticalField, 'key'> & { sql: string; values?: readonly string[] };

export const measureCatalog: Record<BusinessMeasure, MeasureDefinition> = {
  gross_sales: { label: 'GMV', semanticType: 'currency', unit: '元', definition: '已支付订单在退款前的商品成交总额。', formula: 'SUM(gross_sales_cents) / 100', owner: '经营分析组', sql: 'ROUND(SUM(gross_sales_cents) / 100.0, 2)' },
  net_sales: { label: '退款后销售额', semanticType: 'currency', unit: '元', definition: 'GMV 扣除已记录退款金额后的经营销售额，不等同于会计营收。', formula: 'SUM(gross_sales_cents - refund_cents) / 100', owner: '经营分析组', sql: 'ROUND(SUM(gross_sales_cents - refund_cents) / 100.0, 2)' },
  order_count: { label: '支付订单量', semanticType: 'count', unit: '单', definition: '完成支付的订单数量。', formula: 'SUM(order_count)', owner: '交易产品组', sql: 'SUM(order_count)' },
  average_order_value: { label: '退款后客单价', semanticType: 'currency', unit: '元', definition: '退款后销售额除以支付订单量。', formula: 'SUM(gross_sales_cents - refund_cents) / 100 / SUM(order_count)', owner: '经营分析组', sql: 'ROUND(SUM(gross_sales_cents - refund_cents) / 100.0 / NULLIF(SUM(order_count), 0), 2)' },
  refund_rate: { label: '退款率', semanticType: 'percent', unit: '%', definition: '已记录退款金额占 GMV 的比例。', formula: 'SUM(refund_cents) / SUM(gross_sales_cents) * 100', owner: '售后运营组', sql: 'ROUND(SUM(refund_cents) * 100.0 / NULLIF(SUM(gross_sales_cents), 0), 2)' },
};

const regions = ['华东', '华南', '华北', '华中', '西部', '东北'] as const;
const channels = ['直营网店', '平台电商', '直播', '内容电商'] as const;
const categories = ['数码家电', '家居生活', '美妆个护', '食品饮料', '服饰鞋包', '运动户外'] as const;

export const dimensionCatalog: Record<BusinessDimension, DimensionDefinition> = {
  date: { label: '日期', role: 'time', dataType: 'date', sql: 'sale_date' },
  month: { label: '月份', role: 'time', dataType: 'date', sql: "substr(sale_date, 1, 7)" },
  region: { label: '区域', role: 'dimension', dataType: 'string', sql: 'region', values: regions },
  channel: { label: '渠道', role: 'dimension', dataType: 'string', sql: 'channel', values: channels },
  category: { label: '品类', role: 'dimension', dataType: 'string', sql: 'category', values: categories },
};

export const filterValues: Record<BusinessFilterField, readonly string[]> = {
  region: regions,
  channel: channels,
  category: categories,
};

export const businessCatalog: BusinessCatalogSummary = {
  version: 'sales-demo-v2',
  measures: Object.entries(measureCatalog).map(([key, definition]) => ({
    key: key as BusinessMeasure,
    label: definition.label,
    semanticType: definition.semanticType,
    unit: definition.unit,
    definition: definition.definition,
    formula: definition.formula,
    owner: definition.owner,
  })),
  dimensions: Object.entries(dimensionCatalog).map(([key, definition]) => ({
    key: key as BusinessDimension,
    label: definition.label,
    role: definition.role,
    dataType: definition.dataType,
    ...(definition.values ? { values: [...definition.values] } : {}),
  })),
  limits: { maxMeasures: 3, maxDimensions: 2, maxFilters: 4, maxRows: 50 },
};

export function measureField(key: BusinessMeasure): BusinessAnalyticalField {
  const definition = measureCatalog[key];
  return { key, label: definition.label, role: 'measure', dataType: 'number', semanticType: definition.semanticType, unit: definition.unit, definition: definition.definition, formula: definition.formula, owner: definition.owner };
}

export function dimensionField(key: BusinessDimension): BusinessAnalyticalField {
  const definition = dimensionCatalog[key];
  return { key, label: definition.label, role: definition.role, dataType: definition.dataType };
}
