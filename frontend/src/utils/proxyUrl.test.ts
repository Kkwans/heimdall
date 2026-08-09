import { describe, expect, it } from 'vitest'
import { buildProxyBaseUrls } from './proxyUrl'

describe('buildProxyBaseUrls', () => {
  it('uses the browser scheme and hostname for a remote NAS', () => {
    expect(buildProxyBaseUrls(
      { proxy_port: 9888 },
      { protocol: 'http:', hostname: '192.168.5.110' },
    )).toEqual({
      openai: 'http://192.168.5.110:9888/openai',
      anthropic: 'http://192.168.5.110:9888/anthropic',
    })
  })

  it('prefers an explicit public base URL and removes trailing slashes', () => {
    expect(buildProxyBaseUrls(
      { proxy_port: 9888, public_base_url: 'https://gateway.example.com///' },
      { protocol: 'http:', hostname: 'localhost' },
    ).openai).toBe('https://gateway.example.com/openai')
  })

  it('supports independent OpenAI and Anthropic public addresses', () => {
    expect(buildProxyBaseUrls(
      {
        proxy_port: 9888,
        openai_base_url: 'https://openai.example.com/gateway///',
        anthropic_base_url: 'https://anthropic.example.com/proxy/',
      },
      { protocol: 'http:', hostname: 'localhost' },
    )).toEqual({
      openai: 'https://openai.example.com/gateway',
      anthropic: 'https://anthropic.example.com/proxy',
    })
  })

  it('wraps an IPv6 hostname before appending the deployment port', () => {
    expect(buildProxyBaseUrls(
      { proxy_port: 9888 },
      { protocol: 'https:', hostname: '2001:db8::1' },
    ).anthropic).toBe('https://[2001:db8::1]:9888/anthropic')
  })
})
