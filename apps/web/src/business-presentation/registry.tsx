import { defineRegistry } from '@json-render/react';
import { businessPresentationCatalog } from './catalog.js';

const lineColors = ['#4055f4', '#12a594', '#d97706', '#db2777'];

function formatValue(value: string | number, unit: string): string {
  if (typeof value !== 'number') return value;
  if (unit === '元') return `¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
  if (unit === '%') return `${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}%`;
  return value.toLocaleString('zh-CN', { maximumFractionDigits: 2 });
}

export const { registry: businessPresentationRegistry } = defineRegistry(businessPresentationCatalog, {
  components: {
    AnalysisPanel: ({ props, children }) => <section className="business-presentation"><header className="business-presentation-header"><span>动态数据视图</span><strong>{props.title}</strong><small>{props.subtitle}</small></header><div className="business-presentation-body">{children}</div></section>,
    MetricGrid: ({ props }) => <div className="business-metric-grid">{props.items.map((item) => <div className="business-metric" key={item.label}><span>{item.label}</span><strong>{item.value}</strong><small>{item.meta}</small></div>)}</div>,
    BarChart: ({ props }) => {
      const maximum = Math.max(...props.rows.map((row) => row.value), 1);
      return <figure className="business-chart"><figcaption>{props.title}</figcaption><div className="business-bars">{props.rows.map((row) => <div className="business-bar-row" key={row.label}><span>{row.label}</span><div><i style={{ width: `${Math.max(2, row.value / maximum * 100)}%` }} /></div><strong>{formatValue(row.value, props.unit)}</strong></div>)}</div></figure>;
    },
    LineChart: ({ props }) => {
      const width = 720;
      const height = 220;
      const padding = 24;
      const allValues = props.series.flatMap((series) => series.values);
      const minimum = Math.min(...allValues, 0);
      const maximum = Math.max(...allValues, 1);
      const range = Math.max(maximum - minimum, 1);
      const points = (values: number[]) => values.map((value, index) => `${padding + index * (width - padding * 2) / Math.max(props.labels.length - 1, 1)},${height - padding - (value - minimum) / range * (height - padding * 2)}`).join(' ');
      return <figure className="business-chart business-line-chart"><figcaption>{props.title}</figcaption>{props.series.length > 1 ? <div className="business-chart-legend">{props.series.map((series, index) => <span key={series.name}><i style={{ background: lineColors[index % lineColors.length] }} />{series.name}</span>)}</div> : null}<svg role="img" aria-label={props.title} viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none"><line x1={padding} y1={height - padding} x2={width - padding} y2={height - padding} />{props.series.map((series, index) => <polyline key={series.name} points={points(series.values)} style={{ stroke: lineColors[index % lineColors.length] }} />)}</svg><div className="business-line-labels">{props.labels.map((label, index) => <span key={label}>{label}{props.series.length === 1 ? <small>{formatValue(props.series[0]?.values[index] ?? 0, props.unit)}</small> : null}</span>)}</div></figure>;
    },
    DataTable: ({ props }) => <div className="business-table-wrap"><table className="business-table"><thead><tr>{props.columns.map((column) => <th key={column.key}>{column.label}{column.unit ? `（${column.unit}）` : ''}</th>)}</tr></thead><tbody>{props.rows.map((row, index) => <tr key={index}>{props.columns.map((column) => <td key={column.key}>{formatValue(row[column.key] ?? '—', column.unit)}</td>)}</tr>)}</tbody></table></div>,
    DataScope: ({ props }) => <dl className="business-data-scope"><div><dt>时间范围</dt><dd>{props.from} 至 {props.to}</dd></div><div><dt>数据规模</dt><dd>{props.datasetRows.toLocaleString('zh-CN')} 行</dd></div><div><dt>场景生成</dt><dd>{props.model} · {props.concurrency} 并行 · {props.scenarios} 场景</dd></div><div><dt>新鲜度</dt><dd>{props.freshness}</dd></div></dl>,
    Notice: ({ props }) => <p className="business-notice">{props.text}</p>,
  },
});
