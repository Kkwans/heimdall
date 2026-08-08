export interface ProxyUrlConfig {
  proxy_port: number
  public_base_url?: string
}

export interface BrowserLocation {
  protocol: string
  hostname: string
}

function formatHostname(hostname: string): string {
  if (hostname.includes(':') && !hostname.startsWith('[')) return `[${hostname}]`
  return hostname
}

export function buildProxyBaseUrls(
  config: ProxyUrlConfig,
  location: BrowserLocation,
): { openai: string; anthropic: string } {
  const explicit = config.public_base_url?.trim().replace(/\/+$/, '')
  const fallback = `${location.protocol}//${formatHostname(location.hostname)}:${config.proxy_port}`
  const base = explicit || fallback
  return {
    openai: `${base}/openai`,
    anthropic: `${base}/anthropic`,
  }
}
