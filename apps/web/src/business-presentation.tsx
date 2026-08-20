import { useMemo } from 'react';
import type { BusinessAnalysis } from '@pi-workbench/contracts';
import { validateSpec } from '@json-render/core';
import { JSONUIProvider, Renderer } from '@json-render/react';
import { businessPresentationRegistry } from './business-presentation/registry.js';
import { toJsonRenderSpec } from './business-presentation/to-json-render-spec.js';

export function BusinessPresentationView({ analysis }: { analysis: BusinessAnalysis }) {
  const spec = useMemo(() => toJsonRenderSpec(analysis), [analysis]);
  const validation = validateSpec(spec);
  if (!validation.valid) throw new Error('经营分析展示计划未通过 json-render 校验');
  return <JSONUIProvider registry={businessPresentationRegistry}><Renderer spec={spec} registry={businessPresentationRegistry} /></JSONUIProvider>;
}
