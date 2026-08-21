import type { Spec } from '@json-render/core';
import type { BusinessAnalysis, BusinessAnalyticalField, BusinessDimension, BusinessMeasure, BusinessPresentationBlock } from '@pi-workbench/contracts';

function fieldMap(fields: BusinessAnalyticalField[]): Map<string, BusinessAnalyticalField> {
  return new Map(fields.map((field) => [field.key, field]));
}

function formatValue(value: number, field: BusinessAnalyticalField): string {
  if (field.semanticType === 'currency') return `¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
  if (field.semanticType === 'percent') return `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%`;
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

function compositeLabel(row: Record<string, string | number>, fields: BusinessDimension[]): string {
  return fields.map((field) => String(row[field] ?? '全部')).join(' · ');
}

function summaryElement(analysis: BusinessAnalysis, block: Extract<BusinessPresentationBlock, { type: 'summary' }>, fields: Map<string, BusinessAnalyticalField>) {
  const measure = fields.get(block.primaryMeasure)!;
  const peak = analysis.result.rows.reduce<Record<string, string | number>>((current, row) => Number(row[block.primaryMeasure] ?? 0) > Number(current[block.primaryMeasure] ?? Number.NEGATIVE_INFINITY) ? row : current, {});
  const dimensionLabel = block.dimensionFields.some((key) => fields.get(key)?.role === 'time') ? '峰值时间' : block.dimensionFields.length ? '最大值项' : '查询范围';
  const dimensionValue = block.dimensionFields.length ? compositeLabel(peak, block.dimensionFields) : '全部';
  return {
    type: 'MetricGrid',
    props: { items: [
      { label: '返回行数', value: String(analysis.result.metadata.rowCount), meta: '当前查询结果' },
      { label: dimensionLabel, value: dimensionValue, meta: measure.label },
      { label: `最大${measure.label}`, value: formatValue(Number(peak[block.primaryMeasure] ?? 0), measure), meta: `查询最大值 · ${measure.unit ?? ''}` },
      { label: '数据规模', value: analysis.result.metadata.datasetRows.toLocaleString('zh-CN'), meta: '日粒度聚合行' },
    ] },
    children: [],
  };
}

function chartElement(analysis: BusinessAnalysis, block: Extract<BusinessPresentationBlock, { type: 'chart' }>, fields: Map<string, BusinessAnalyticalField>) {
  const measure = fields.get(block.yField)!;
  if (block.chart === 'bar') {
    return { type: 'BarChart', props: { title: block.title, unit: measure.unit ?? '', rows: analysis.result.rows.map((row) => ({ label: compositeLabel(row, [block.xField, ...(block.seriesField ? [block.seriesField] : [])]), value: Number(row[block.yField] ?? 0) })) }, children: [] };
  }
  const labels = [...new Set(analysis.result.rows.map((row) => String(row[block.xField] ?? '')))].sort();
  const seriesNames = block.seriesField ? [...new Set(analysis.result.rows.map((row) => String(row[block.seriesField!] ?? '全部')))] : [measure.label];
  const series = seriesNames.map((name) => ({
    name,
    values: labels.map((label) => {
      const row = analysis.result.rows.find((candidate) => String(candidate[block.xField] ?? '') === label && (!block.seriesField || String(candidate[block.seriesField] ?? '全部') === name));
      const value = row?.[block.yField];
      return typeof value === 'number' ? value : null;
    }),
  }));
  return { type: 'LineChart', props: { title: block.title, unit: measure.unit ?? '', labels, series }, children: [] };
}

export function toJsonRenderSpec(analysis: BusinessAnalysis): Spec {
  const fields = fieldMap(analysis.result.fields);
  const elements: Spec['elements'] = {};
  for (const block of analysis.presentation.blocks) {
    if (block.type === 'summary') elements[block.id] = summaryElement(analysis, block, fields);
    if (block.type === 'chart') elements[block.id] = chartElement(analysis, block, fields);
    if (block.type === 'table') elements[block.id] = { type: 'DataTable', props: { columns: block.fields.map((key) => ({ key, label: fields.get(key)?.label ?? key, unit: fields.get(key)?.unit ?? '' })), rows: analysis.result.rows }, children: [] };
    if (block.type === 'scope') elements[block.id] = { type: 'DataScope', props: { from: analysis.result.metadata.timeWindow.from, to: analysis.result.metadata.timeWindow.to, freshness: analysis.result.metadata.freshness, datasetRows: analysis.result.metadata.datasetRows, model: analysis.result.metadata.generation.model, concurrency: analysis.result.metadata.generation.concurrency, scenarios: analysis.result.metadata.generation.scenarios }, children: [] };
    if (block.type === 'notice') elements[block.id] = { type: 'Notice', props: { text: analysis.result.metadata.limitations.join(' ') }, children: [] };
  }
  return {
    root: 'analysis',
    elements: {
      analysis: { type: 'AnalysisPanel', props: { title: analysis.presentation.title, subtitle: `${analysis.result.metadata.timeWindow.from} 至 ${analysis.result.metadata.timeWindow.to}` }, children: analysis.presentation.blocks.map((block) => block.id) },
      ...elements,
    },
  };
}
