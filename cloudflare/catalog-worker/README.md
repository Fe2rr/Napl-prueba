# NAPL Catalog Worker (Base de datos separada de Ratings/Votes)

Este Worker reemplaza el CSV de Google Sheets con una base de datos **Cloudflare D1** dedicada exclusivamente al catálogo (`platforms`, `games`, `ports`), manteniendo intacto y separado tu Worker de votos (`ports-ratings-worker`).

## Pasos para desplegar en Cloudflare

### 1. Crear la nueva base de datos D1
Desde la carpeta `cloudflare/catalog-worker`:

```bash
npx wrangler d1 create napl-catalog-db
```

Copia el `database_id` que te devuelva Wrangler y pégalo en `wrangler.toml`.

### 2. Crear las tablas en D1
```bash
npx wrangler d1 execute napl-catalog-db --remote --file=./schema.sql
```

### 3. Generar e importar los datos (Catálogo, Dispositivos y Popularidad)
```bash
node scripts/migrate-from-sheet.mjs
node scripts/migrate-popularity.mjs

npx wrangler d1 execute napl-catalog-db --remote --file=./seed.sql
npx wrangler d1 execute napl-catalog-db --remote --file=./devices-seed.sql
npx wrangler d1 execute napl-catalog-db --remote --file=./popularity-seed.sql
```

### 4. Desplegar el Worker
```bash
npx wrangler deploy
```

Luego pega la URL de tu Worker en `CATALOG_API_BASE` dentro de `public/js/core/config.js` para que el frontend use 100% Cloudflare.

## Endpoints disponibles

- `GET /health` — Verifica conexión y conteo de juegos/ports.
- `GET /catalog` — Devuelve `{ success: true, platforms, games }` ya agrupado y listo para el frontend (con caché en Edge).
- `GET /games/:slug` — Devuelve el detalle de un juego específico y sus ports.
- `GET /popular?period=week|month|alltime` — Devuelve el ranking de juegos populares desde D1.
- `POST /visit` — Registra una visita a un juego en D1.
- `GET /compatibility?port_ids=...` — Devuelve el resumen `Works? Yes/No` y dispositivos probados.
- `POST /compatibility` — Guarda un reporte validado contra la tabla `devices`.
