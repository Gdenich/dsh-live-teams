import { createRequire } from 'node:module'

/**
 * Does this host still offer what the plugin uses?
 *
 * The plugin leans on host services by name: `sessionController.create`, `agents.get`, the system
 * prompt seat, the workspace registry, the tools registry and the web server. A DSH release can
 * rename or drop any of them, and the failure mode without a check is the one the human named:
 * "I updated DSH and everything broke" — with no message saying what broke.
 *
 * So the plugin asks the host what it has, compares it against a declared list, and says the answer
 * out loud. A required capability that is missing turns the team off with a reason instead of
 * half-working; an optional one (a headless composition has no web server) is reported as degraded.
 *
 * This is a check, not a negotiation: it does not try to emulate a missing API.
 */
export type HostCapability = {
  /** The host surface, named as it is used. */
  readonly name: string
  /** Required capabilities decide whether the team runs at all. */
  readonly required: boolean
  readonly present: (host: HostSurface) => boolean
}

/** The shape this file is allowed to inspect: whatever the Cordis context exposes by name. */
export type HostSurface = Record<string, unknown>

export type CompatibilityVerdict = {
  readonly verdict: 'compatible' | 'degraded' | 'incompatible'
  readonly hostVersion?: string
  /** Required capabilities the host does not offer. */
  readonly missing: readonly string[]
  /** Optional capabilities the host does not offer. */
  readonly absent: readonly string[]
  /** One line a person can read, whether or not anything is wrong. */
  readonly detail: string
}

/**
 * Read a host service the way the plugin itself does.
 *
 * Cordis **throws** when a service that was not declared in `inject` is read as a property, so a
 * compatibility check that pokes at `ctx.tools` does not report a missing service — it crashes the
 * plugin it was meant to protect. The safe reader is `ctx.get(name)`; the property access stays as a
 * fallback for a plain object, wrapped so that a throwing host reads as "not available".
 */
function service(host: HostSurface, name: string): unknown {
  try {
    const get = host.get
    if (typeof get === 'function') return (get as (key: string) => unknown).call(host, name)
  } catch { return undefined }
  try { return host[name] } catch { return undefined }
}

function hasFunction(host: HostSurface, name: string, member?: string): boolean {
  const value = service(host, name)
  if (value === undefined || value === null) return false
  if (member === undefined) return true
  try {
    const target = (value as Record<string, unknown>)[member]
    return typeof target === 'function'
  } catch { return false }
}

/**
 * The host surfaces this plugin calls, and whether it can live without them.
 *
 * Keep this list honest: it is the contract with the host. Adding a call to a new service without
 * adding it here means the next DSH release can remove it silently.
 */
export const HOST_CAPABILITIES: readonly HostCapability[] = Object.freeze([
  { name: 'sessionController.create', required: true, present: (host) => hasFunction(host, 'sessionController', 'create') },
  { name: 'agents.get', required: true, present: (host) => hasFunction(host, 'agents', 'get') },
  { name: 'systemPrompt', required: true, present: (host) => service(host, 'systemPrompt') !== undefined && service(host, 'systemPrompt') !== null },
  { name: 'workspaceRegistry', required: true, present: (host) => service(host, 'workspaceRegistry') !== undefined && service(host, 'workspaceRegistry') !== null },
  { name: 'tools.register', required: false, present: (host) => hasFunction(host, 'tools', 'register') },
  { name: 'webServer.register', required: false, present: (host) => hasFunction(host, 'webServer', 'register') },
])

/** The version of the host packages this plugin is running against, when it can be read. */
export function hostVersion(): string | undefined {
  try {
    const require = createRequire(import.meta.url)
    for (const name of ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-session']) {
      try {
        const manifest = require(`${name}/package.json`) as { version?: unknown }
        if (typeof manifest.version === 'string') return manifest.version
      } catch { /* the package may not be resolvable from here; try the next one */ }
    }
  } catch { /* no resolver: the version is simply unknown */ }
  return undefined
}

/** The versions this plugin declares support for, read from its own manifest. */
export function declaredReleases(): readonly string[] {
  try {
    const require = createRequire(import.meta.url)
    const manifest = require('../package.json') as { dsh?: { compatibility?: { dshReleases?: Record<string, string> } } }
    return Object.keys(manifest.dsh?.compatibility?.dshReleases ?? {})
  } catch { return [] }
}

export function checkCompatibility(host: HostSurface, options: { hostVersion?: string; declared?: readonly string[]; capabilities?: readonly HostCapability[] } = {}): CompatibilityVerdict {
  const capabilities = options.capabilities ?? HOST_CAPABILITIES
  const missing = capabilities.filter((capability) => capability.required && !capability.present(host)).map((capability) => capability.name)
  const absent = capabilities.filter((capability) => !capability.required && !capability.present(host)).map((capability) => capability.name)
  const version = options.hostVersion ?? hostVersion()
  const declared = options.declared ?? declaredReleases()
  // A version the manifest does not mention is not an error by itself — the check exists because the
  // host can change under a plugin — but it is worth saying, and it is what an update looks like.
  const undeclared = version !== undefined && declared.length > 0 && !declared.includes(version)
  const verdict = missing.length > 0 ? 'incompatible' as const : absent.length > 0 || undeclared ? 'degraded' as const : 'compatible' as const
  const detail = missing.length > 0
    ? `DSH ${version ?? 'of unknown version'} does not offer ${missing.join(', ')}; the team stays off until the plugin is updated`
    : absent.length > 0
      ? `running without ${absent.join(', ')}; the team works, the surfaces they serve do not`
      : undeclared
        ? `DSH ${version ?? 'of unknown version'} is not in this plugin's declared releases (${declared.join(', ')}); everything the plugin calls is present`
        : `DSH ${version ?? 'of unknown version'} offers everything this plugin calls`
  return { verdict, ...(version === undefined ? {} : { hostVersion: version }), missing, absent, detail }
}
