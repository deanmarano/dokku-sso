# Homelab App Integrations

This document tracks integrations for the dokku-auth plugin. Each integration provides pre-configured OIDC client settings and/or LDAP configuration helpers for popular self-hosted applications.

> **Warning:** Most integrations listed here are **untested** and were ported from an earlier
> version of the plugin. Only a subset have been validated with E2E tests (marked with ✅ below).
> Please report issues or contribute tests to help validate them.

## Quick Start

```bash
# Link an app to the directory service (sets LDAP env vars)
dokku auth:link <service> <app>

# Add an OIDC client for an app
dokku auth:oidc:add-client <frontend-service> <client-id> [secret] [redirect-uri]

# Protect an app with SSO (forward auth)
dokku auth:frontend:protect <frontend-service> <app>
```

## Available Presets (36 apps)

Legend: ✅ = Tested with E2E tests

### Tier 1: Full OIDC + LDAP Support

| Preset | App | OIDC | LDAP | Proxy Auth | Tested |
|--------|-----|------|------|------------|--------|
| `nextcloud` | [Nextcloud](https://nextcloud.com) | ✓ | ✓ | ✓ | |
| `gitea` | [Gitea](https://gitea.io) / Forgejo | ✓ | ✓ | ✓ | |
| `portainer` | [Portainer](https://portainer.io) | ✓ | ✓ | - | |
| `proxmox` | [Proxmox VE](https://proxmox.com) | ✓ | ✓ | - | |
| `gitlab` | [GitLab](https://gitlab.com) | ✓ | ✓ | - | ✅ |
| `bookstack` | [BookStack](https://www.bookstackapp.com) | ✓ | ✓ | - | |
| `hedgedoc` | [HedgeDoc](https://hedgedoc.org) | ✓ | ✓ | - |
| `guacamole` | [Apache Guacamole](https://guacamole.apache.org) | ✓ | ✓ | ✓ |

### Tier 2: OIDC Support

| Preset | App | OIDC | LDAP | Proxy Auth | Tested |
|--------|-----|------|------|------------|--------|
| `immich` | [Immich](https://immich.app) | ✓ | - | - | ✅ |
| `grafana` | [Grafana](https://grafana.com) | ✓ | ✓ | - | ✅ |
| `audiobookshelf` | [Audiobookshelf](https://audiobookshelf.org) | ✓ | - | - | |
| `miniflux` | [Miniflux](https://miniflux.app) | ✓ | - | ✓ | |
| `openwebui` | [Open WebUI](https://openwebui.com) | ✓ | - | - | |
| `outline` | [Outline](https://getoutline.com) | ✓ | - | - | |
| `matrix` | [Matrix Synapse](https://matrix.org) | ✓ | ✓ | - | |
| `wikijs` | [Wiki.js](https://js.wiki) | ✓ | ✓ | - | |
| `paperless` | [Paperless-ngx](https://docs.paperless-ngx.com) | ✓ | - | ✓ | |
| `overseerr` | [Overseerr](https://overseerr.dev) | ✓ | - | ✓ | |
| `jellyseerr` | [Jellyseerr](https://github.com/Fallenbagel/jellyseerr) | ✓ | - | ✓ | |

### Tier 3: LDAP Only

| Preset | App | OIDC | LDAP | Proxy Auth | Tested |
|--------|-----|------|------|------------|--------|
| `jellyfin` | [Jellyfin](https://jellyfin.org) | - | ✓ (plugin) | - | ✅ |
| `emby` | [Emby](https://emby.media) | - | ✓ (plugin) | - | |
| `vaultwarden` | [Vaultwarden](https://github.com/dani-garcia/vaultwarden) | - | ✓ | ✓ | |
| `calibreweb` | [Calibre-Web](https://github.com/janeczku/calibre-web) | - | ✓ | ✓ | |

### Tier 4: Proxy Auth Only

| Preset | App | OIDC | LDAP | Proxy Auth | Tested |
|--------|-----|------|------|------------|--------|
| `plex` | [Plex](https://plex.tv) | - | - | ✓ (web only) | |
| `arr` | [*arr stack](https://wiki.servarr.com) (generic) | - | - | ✓ | |
| `radarr` | [Radarr](https://radarr.video) | - | - | ✓ | ✅ |
| `sonarr` | [Sonarr](https://sonarr.tv) | - | - | ✓ | |
| `lidarr` | [Lidarr](https://lidarr.audio) | - | - | ✓ | |
| `prowlarr` | [Prowlarr](https://prowlarr.com) | - | - | ✓ | |
| `bazarr` | [Bazarr](https://bazarr.media) | - | - | ✓ | |
| `readarr` | [Readarr](https://readarr.com) | - | - | ✓ | |
| `uptimekuma` | [Uptime Kuma](https://uptime.kuma.pet) | - | - | ✓ | |
| `syncthing` | [Syncthing](https://syncthing.net) | - | - | ✓ | |
| `homeassistant` | [Home Assistant](https://home-assistant.io) | - | - | ✓ | ✅ |
| `navidrome` | [Navidrome](https://navidrome.org) | - | - | ✓ | |
| `linkding` | [Linkding](https://github.com/sissbruecker/linkding) | - | - | ✓ | |

## Integration Examples

### OIDC Integration (Immich)

```bash
# Create auth service
dokku auth:create default --gateway-domain auth.example.com

# Integrate Immich with OIDC
dokku auth:integrate default immich-app --preset immich --set-env

# Or manually with oidc:add
dokku auth:oidc:add default immich --preset immich --domain photos.example.com
```

### LDAP Integration (Jellyfin)

```bash
# Jellyfin uses LDAP only (no OIDC)
dokku auth:integrate default jellyfin-app --preset jellyfin

# Follow the printed instructions to configure LDAP plugin
```

### Forward Auth Protection (*arr stack)

```bash
# Protect Radarr with forward auth, bypass API
dokku auth:protect radarr-app --service default --bypass-path "/api/*"

# Protect Sonarr similarly
dokku auth:protect sonarr-app --service default --bypass-path "/api/*" --bypass-path "/feed/*"
```

## Preset Details

### Environment Variable Support

Some presets can automatically set environment variables with `--set-env`:

| Preset | Auto-configurable via env vars |
|--------|-------------------------------|
| `immich` | ✓ Full OIDC config |
| `grafana` | ✓ Full OIDC config |
| `bookstack` | ✓ Full OIDC config |
| `hedgedoc` | ✓ Full OIDC config |
| `outline` | ✓ Full OIDC config |
| `miniflux` | ✓ Full OIDC config |
| `openwebui` | ✓ Full OIDC config |
| `paperless` | ✓ Full OIDC config |
| `navidrome` | ✓ Proxy auth headers |
| `linkding` | ✓ Proxy auth headers |

### Apps Requiring Manual Configuration

These apps require configuration via admin UI or config files:

- `nextcloud` - Via `occ` commands
- `gitea` - Via admin UI or CLI
- `portainer` - Via admin UI
- `proxmox` - Via `pveum` commands
- `gitlab` - Via `gitlab.rb`
- `jellyfin` - Via plugin settings
- `wikijs` - Via admin UI
- `matrix` - Via `homeserver.yaml`
- `guacamole` - Via `guacamole.properties`

## Common Bypass Paths

When using forward auth, these paths are commonly bypassed:

| App Type | Bypass Paths | Reason |
|----------|--------------|--------|
| *arr apps | `/api/*`, `/feed/*` | External tools, RSS |
| Media servers | `/api/*` | Mobile apps, clients |
| Monitoring | `/api/*`, `/metrics` | Prometheus scraping |
| Sync apps | `/rest/*` | Sync clients |

## References

- [Self-hosted Authentication Table](https://github.com/d-513/selfhosted-authentication-table)
- [Authelia OpenID Connect Docs](https://www.authelia.com/integration/openid-connect/)
- [Authelia Integration Guide](https://www.authelia.com/integration/prologue/get-started/)
- [LLDAP Documentation](https://github.com/lldap/lldap)
