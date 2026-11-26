// OAuth2 login (osm-auth) and changeset upload.

import { osmAuth } from 'osm-auth';
import { applyDiffResult, buildChangesetXml, buildOsmChange, type OsmData, type OsmRelation, type OsmWay, type ServerConfig, type Tags } from './osm';

const CLIENT_KEY = 'osm-lanes-3d.clientId.';

/** Client IDs can be baked in at build time or entered in Settings. */
export function getClientId(serverName: string): string {
  const env = import.meta.env as Record<string, string | undefined>;
  const baked = serverName === 'dev' ? env.VITE_OSM_DEV_CLIENT_ID : env.VITE_OSM_CLIENT_ID;
  try {
    return localStorage.getItem(CLIENT_KEY + serverName) || baked || '';
  } catch {
    return baked || '';
  }
}

export function setClientId(serverName: string, id: string) {
  try {
    if (id) localStorage.setItem(CLIENT_KEY + serverName, id);
    else localStorage.removeItem(CLIENT_KEY + serverName);
  } catch {
    /* storage unavailable */
  }
}

export function redirectUri(): string {
  const u = new URL('land.html', location.href);
  u.hash = '';
  u.search = '';
  return u.toString();
}

export class Uploader {
  private auth: osmAuth | null = null;
  constructor(private server: ServerConfig, private serverName: string) {}

  private get a(): osmAuth {
    const client_id = getClientId(this.serverName);
    if (!client_id) throw new Error('No OAuth2 client ID set. Open Settings and add one for this server.');
    if (!this.auth || this.auth.options().client_id !== client_id) {
      this.auth = new osmAuth({
        client_id,
        redirect_uri: redirectUri(),
        scope: 'read_prefs write_api',
        url: this.server.webUrl,
        apiUrl: this.server.apiUrl,
      });
    }
    return this.auth;
  }

  authenticated(): boolean {
    try {
      return this.a.authenticated();
    } catch {
      return false;
    }
  }

  async login(): Promise<void> {
    await this.a.authenticateAsync();
  }

  logout() {
    try {
      this.a.logout();
    } catch {
      /* nothing to clear */
    }
  }

  private async call(method: 'GET' | 'PUT' | 'POST', path: string, body?: string): Promise<string> {
    const res = await this.a.fetch(this.server.apiUrl + path, {
      method,
      body,
      headers: body ? { 'Content-Type': 'text/xml; charset=utf-8' } : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
    return text;
  }

  async userName(): Promise<string> {
    const json = JSON.parse(await this.call('GET', '/api/0.6/user/details.json'));
    return json.user?.display_name ?? '';
  }

  /** Create changeset, upload the diff, close it. Returns the changeset id. */
  async upload(ways: OsmWay[], relations: OsmRelation[], data: OsmData, changesetTags: Tags, onStep: (s: string) => void): Promise<number> {
    if (!ways.length && !relations.length) throw new Error('Nothing to upload');
    if (!this.authenticated()) {
      onStep('Signing in…');
      await this.login();
    }
    onStep('Opening changeset…');
    const id = Number(await this.call('PUT', '/api/0.6/changeset/create', buildChangesetXml(changesetTags)));
    try {
      onStep(`Uploading ${ways.length + relations.length} change${ways.length + relations.length > 1 ? 's' : ''} to changeset ${id}…`);
      const result = await this.call('POST', `/api/0.6/changeset/${id}/upload`, buildOsmChange(ways, id, relations));
      applyDiffResult(result, data);
    } finally {
      onStep('Closing changeset…');
      await this.call('PUT', `/api/0.6/changeset/${id}/close`).catch(() => undefined);
    }
    return id;
  }
}
