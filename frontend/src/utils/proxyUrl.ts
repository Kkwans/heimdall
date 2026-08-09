export interface ProxyUrlConfig {
  proxy_port: number
  public_base_url?: string
  openai_base_url?: string
  anthropic_base_url?: string
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
  const legacyExplicit = config.public_base_url?.trim().replace(/\/+$/, '')
  const explicitOpenAI = config.openai_base_url?.trim().replace(/\/+$/, '')
  const explicitAnthropic = config.anthropic_base_url?.trim().replace(/\/+$/, '')
  const fallback = `${location.protocol}//${formatHostname(location.hostname)}:${config.proxy_port}`
  return {
    openai: explicitOpenAI || `${legacyExplicit || fallback}/openai`,
    anthropic: explicitAnthropic || `${legacyExplicit || fallback}/anthropic`,
  }
}
