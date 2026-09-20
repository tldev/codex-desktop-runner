export interface Execution {
  model?: string;
  effort?: string;
}
export function execution(model?: string, effort?: string): Execution {
  if (model !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(model))
    throw new Error('Invalid model identifier');
  if (
    effort !== undefined &&
    !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)
  )
    throw new Error('Invalid reasoning effort');
  return { ...(model === undefined ? {} : { model }), ...(effort === undefined ? {} : { effort }) };
}
