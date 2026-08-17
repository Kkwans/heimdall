export interface ProxyUrlConfig {
  proxy_port: number
  public_base_url?: string
  openai_base_path?: string
  anthropic_base_path?: string
  // Read-only compatibility fields returned by older Dashboard versions.
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

function normalizePath(value: string | undefined, fallback: string): string {
  const raw = value?.trim()
  if (!raw) return fallback
  try {
    const parsed = new URL(raw, 'http://heimdall.invalid')
    if (parsed.origin !== 'http://heimdall.invalid' && !raw.startsWith('/')) {
      return parsed.pathname || fallback
    }
    if (parsed.search || parsed.hash || !parsed.pathname.startsWith('/')) return fallback
    return `/${parsed.pathname.replace(/^\/+|\/+$/g, '')}`
  } catch {
    return fallback
  }
}

function joinBase(base: string, path: string): string {
  const normalizedBase = base.replace(/\/+$/, '')
  return `${normalizedBase}/${path.replace(/^\/+/, '')}`
}

export function buildProxyBaseUrls(
  config: ProxyUrlConfig,
  location: BrowserLocation,
): { openai: string; anthropic: string } {
  const legacyExplicit = config.public_base_url?.trim().replace(/\/+$/, '')
  const explicitOpenAI = config.openai_base_url?.trim().replace(/\/+$/, '')
  const explicitAnthropic = config.anthropic_base_url?.trim().replace(/\/+$/, '')
  const fallback = `${location.protocol}//${formatHostname(location.hostname)}:${config.proxy_port}`
  const openaiPath = normalizePath(config.openai_base_path, '/openai')
  const anthropicPath = normalizePath(config.anthropic_base_path, '/anthropic')
  return {
    openai: explicitOpenAI || joinBase(legacyExplicit || fallback, openaiPath),
    anthropic: explicitAnthropic || joinBase(legacyExplicit || fallback, anthropicPath),
  }
}
