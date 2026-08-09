/** 请求传输方式的人类可读名称。 */
export function formatRequestType(stream: boolean | number): 'SSE 流式' | 'JSON 非流式' {
  return stream ? 'SSE 流式' : 'JSON 非流式'
}
