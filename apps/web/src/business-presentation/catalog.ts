import { defineCatalog } from '@json-render/core';
import { schema } from '@json-render/react/schema';
import { z } from 'zod';

const valueSchema = z.union([z.string(), z.number()]);

export const businessPresentationCatalog = defineCatalog(schema, {
  components: {
    AnalysisPanel: { props: z.object({ title: z.string(), subtitle: z.string() }), slots: ['default'], description: '经营分析结果的根布局' },
    MetricGrid: { props: z.object({ items: z.array(z.object({ label: z.string(), value: z.string(), meta: z.string() })) }), description: '查询结果的关键摘要' },
    BarChart: { props: z.object({ title: z.string(), unit: z.string(), rows: z.array(z.object({ label: z.string(), value: z.number() })) }), description: '分类维度横向对比图' },
    LineChart: { props: z.object({ title: z.string(), unit: z.string(), labels: z.array(z.string()), series: z.array(z.object({ name: z.string(), values: z.array(z.number()) })) }), description: '时间维度单序列或多序列趋势图' },
    DataTable: { props: z.object({ columns: z.array(z.object({ key: z.string(), label: z.string(), unit: z.string() })), rows: z.array(z.record(z.string(), valueSchema)) }), description: '任何标准分析结果的通用表格兜底' },
    DataScope: { props: z.object({ from: z.string(), to: z.string(), freshness: z.string(), datasetRows: z.number(), model: z.string(), concurrency: z.number(), scenarios: z.number() }), description: '数据范围和生成来源' },
    Notice: { props: z.object({ text: z.string() }), description: '数据限制提示' },
  },
  actions: {},
});
