import { useMemo } from 'react';
import type { BusinessAnalysis } from '@pi-workbench/contracts';
import { validateSpec } from '@json-render/core';
import { JSONUIProvider, Renderer } from '@json-render/react';
import { businessPresentationRegistry } from './business-presentation/registry.js';
import { toJsonRenderSpec } from './business-presentation/to-json-render-spec.js';

export function BusinessPresentationView({ analysis }: { analysis: BusinessAnalysis }) {
  const spec = useMemo(() => toJsonRenderSpec(analysis), [analysis]);
  const validation = validateSpec(spec);
  if (!validation.valid) return null;
  return <JSONUIProvider registry={businessPresentationRegistry}><Renderer spec={spec} registry={businessPresentationRegistry} fallback={() => null} /></JSONUIProvider>;
}
