import type { BusinessAnalyticalResult, BusinessDimension, BusinessPresentationBlock, BusinessPresentationPlan } from '@pi-workbench/contracts';

function presentationTitle(result: BusinessAnalyticalResult): string {
  const dimensions = result.request.dimensions.map((key) => result.fields.find((field) => field.key === key)?.label ?? key);
  const primaryMeasure = result.fields.find((field) => field.key === result.request.measures[0]);
  if (!dimensions.length) return `${primaryMeasure?.label ?? '经营指标'}概览`;
  if (result.request.dimensions.some((key) => result.fields.find((field) => field.key === key)?.role === 'time')) return `${dimensions.join(' × ')}经营趋势`;
  return `${dimensions.join(' × ')}经营分析`;
}

function chartBlock(result: BusinessAnalyticalResult): Extract<BusinessPresentationBlock, { type: 'chart' }> | undefined {
  if (result.request.presentationIntent === 'detail' || !result.request.dimensions.length) return undefined;
  const timeDimension = result.request.dimensions.find((key) => result.fields.find((field) => field.key === key)?.role === 'time');
  const xField = timeDimension ?? result.request.dimensions[0]!;
  const seriesField = result.request.dimensions.find((key) => key !== xField);
  const chart = timeDimension && result.request.presentationIntent !== 'comparison' && result.request.presentationIntent !== 'ranking' ? 'line' : 'bar';
  const yField = result.request.measures[0]!;
  const yLabel = result.fields.find((field) => field.key === yField)?.label ?? yField;
  return { id: 'primary-chart', type: 'chart', chart, title: `${yLabel} · ${chart === 'line' ? '趋势' : '对比'}`, xField, ...(seriesField ? { seriesField } : {}), yField };
}

export function planBusinessPresentation(result: BusinessAnalyticalResult): BusinessPresentationPlan {
  const blocks: BusinessPresentationBlock[] = [
    { id: 'summary', type: 'summary', primaryMeasure: result.request.measures[0]!, dimensionFields: result.request.dimensions },
  ];
  const chart = chartBlock(result);
  if (chart) blocks.push(chart);
  blocks.push(
    { id: 'table', type: 'table', fields: result.fields.map((field) => field.key) },
    { id: 'scope', type: 'scope' },
    { id: 'notice', type: 'notice' },
  );
  return { version: '1', title: presentationTitle(result), blocks };
}
