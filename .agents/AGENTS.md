# Project Memory & Rules - WasaP & BotWaba Production Environment

This document stores the configuration, production paths, ports, PM2 processes, and routing for the WasaP CRM and BotWaba bridge on the VPS to ensure continuity across agent sessions.

## 0. CHANGELOG (recent sessions)

### Aug 17-18, 2026 — Supabase 100-Year Tokens, PostgreSQL Direct Pool Migration & 600ms Debounce
- **Supabase 100-Year Token Renewal:**
  - Old default 1-year tokens issued Aug 7, 2025 (`iat: 1754605117`, `exp: 1786141117`) expired on Aug 7, 2026, causing PostgREST `401 Unauthorized` / `JWT expired` errors across CRM and Bot.
  - Generated perpetual JWT keys with 100-year validity (until 2101/2126):
    - `ANON_KEY`: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzg2MTQxOTA2LCJleHAiOjIxMDE1MDE5MDZ9.OsVgu2tPsCuO9cNPSbNCfSLHvAKGgaHwfHzWHoIVgWY`
    - `SERVICE_ROLE_KEY`: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoic2VydmljZV9yb2xlIiwiaXNzIjoic3VwYWJhc2UiLCJpYXQiOjE3ODYxNDE5MDYsImV4cCI6MjEwMTUwMTkwNn0.i206PssI-MJfQ6855Ao_K-gbdFLLe5UQ94vqT07swQk`
  - Recreated Supabase Docker containers on both servers (`5.189.140.188` and `45.134.226.235`) via `docker compose down && docker compose up -d` (tested `200 OK` on `https://metasupa.mbtech.work/rest/v1/`).
- **PostgreSQL Direct Pool Architecture (`pgPool` / `@/app/lib/db`):**
  - Migrated `/crm` page, `botwaba`'s `aiService.js`, and `server.js` (`/api/internal/log-outbound`) from Supabase PostgREST client to native PostgreSQL client (`pgPool`).
  - Eliminates all PostgREST schema reload dependencies (`NOTIFY pgrst, 'reload schema'`) and RLS authorization locks.
- **Ultra-Fast Debounce (600ms):**
  - Reduced incoming message grouping debounce in `aiService.js` from `2500ms` down to `600ms`.
  - Latency dropped from >5s down to ~2s ("7 corcheas" rhythmic response speed).
- **Live Outbound Message Logging & Ably Event Streaming:**
  - `botwaba/server.js` `/api/internal/log-outbound` persists bot responses directly to `meta_saas.messages` and immediately fires Ably channel event (`get-started`), rendering outbound bot bubbles in `/my-inbox` in real time.
- **Protected Meta App Review Surfaces:**
  - Instagram Comments (`instagram_manage_comments`), Content Publisher (`instagram_content_publish`), Analytics Dashboard (`instagram_manage_insights`), and Human Agent tag (`Human Agent`) remain 100% frozen, compliant, and ready for Meta App Review.

### Aug 13-14, 2026 — Meta App Review & Instagram Comments Funnel (AIDA) + Responsive Inbox
- **Meta App Review Re-submission Preparation:**
  - Rejected permissions addressed: `instagram_business_manage_comments`, `instagram_manage_comments`, `instagram_content_publish`, `instagram_manage_insights`, and `Human Agent`.
  - **Decision:** Removed dependency on simulated static demos (`/demo/index.html`); all features are now fully integrated and recorded in the native SaaS CRM (`https://mbtechpanel.mbtech.work/`).
- **Instagram Comments Moderation (`instagram_manage_comments`):**
  - Interactive comment cards directly in `/my-inbox` with buttons: **`Responder en Post (Público)`** and **`Ocultar Comentario`**.
  - Direct integration with Meta Graph API v20.0: `POST /{comment-id}/replies` and `POST /{comment-id}?is_hidden=true`.
  - Also available in `/post-autoresponder` tab 3 with live post fetching.
  - Eliminated all native browser `prompt()` and `alert()` popups in favor of stylized React/Tailwind modals and inline inputs.
- **Intelligent Comment Autoresponder (AIDA Funnel):**
  - Evaluates incoming comments via LLM / keyword matching in `app/api/webhooks/messenger/route.ts`:
    1. **`OBSCENE`**: Toxic/abusive comments are auto-hidden via API without replies.
    2. **`INTEREST / KEYWORD`**: Public confirmation reply + automated Private DM with AIDA sales pitch and CTA.
    3. **`OTHER / CASUAL`**: Polite public reply only (`¡Muchas gracias por tu comentario...!`) without sending unsolicited DMs.
- **Responsive Layout & Split-Screen Video UX:**
  - Optimized `/my-inbox` for split-screen recordings (browser side-by-side with Instagram app):
    - `PhoneListSidebar` reduced to `w-56 md:w-60 lg:w-64` with high-contrast text and dark/light mode consistency.
    - Conversation list reduced to `w-52 md:w-56 lg:w-60`.
    - Main conversation area expanded with `overflow-x-hidden` (no horizontal scrollbar).
- **Instagram Content Publishing (`instagram_content_publish`):**
  - Native publisher active in `/post-autoresponder` tab 2 (`POST /{ig-user-id}/media` + `POST /{ig-user-id}/media_publish`).
- **Human Agent Tag (`Human Agent`):**
  - Automatic transfer and live manual intervention in `/my-inbox` with badge and bot auto-switch.

### Jul 16, 2026 — Session updates
- **CRM admin password changed** from `admin` to `Garcialv1959/` (deployed to `/root/crm-saas/.env.local`, pm2 restarted). User: `admin@mbtech.work`.
- **MBTech is now Meta Tech Provider** (approved). App ID `1723073642211098`, Business ID `1047109242354157`.
- **Catalog migrated to native Meta Commerce catalog.** Two catalog_ids in use:
  - `1255972477908976` — old catalog, still in `meta_saas.catalogs` and `meta_saas.catalog_products` (15 products, categories empty string for extras/refrescos)
  - `1199850446786643` — NEW active catalog (in `botwaba.commerce_businesses` for Pizzeria mbtech). Same 15 products but with proper `category` values: `Pizza`, `Refresco`, `Extra` (capitalized). `image_url` still NULL (pending upload).
- **commerce_businesses status:** Pizzeria mbtech active (`is_active=t`, catalog_id `1199850446786643`), Hamburguesería El Rey and Shawarma Express inactive (`is_active=f`, no catalog_id).
- **7 bugs identified in aiService.js (botwaba) — NOT YET FIXED:**
  1. `activeDeliveryFee` undefined at line 581 → FATAL when selecting Delivery
  2. `adminPhones` out of scope at line 746 → FATAL in CASO 2 ("Sí" confirmation)
  3. `totalBs` doesn't include delivery fee (line 725) — Bs. calculated on subtotal, USD shown includes delivery
  4. `action_finish_order` doesn't add delivery fee to `order_total_usd` saved in session (line 604)
  5. `isDelivery` always false in CASO 2 (line 744) — `pendingItem` lacks `delivery_type`, ETA always 30 min
  6. Emoji `U0001F4B3` malformed literal in payText (line 601) — should be `\u{1F4B3}` or `💳`
  7. `paymentPagoMovil` undefined at line 598 — works today via short-circuit but latent ReferenceError
- **Idea in exploration (NOT decided):** PWA external app with conversational chatbot less restrictive than WhatsApp. WhatsApp as entry point → redirect to PWA. Pros: rich catalog UX, no Meta limits, outside 24h window. Cons: friction for WhatsApp-native users, data usage. Alternative: PWA only for admin/seller.

### Jul 17, 2026 — Native Meta Commerce Catalog feed fixed + WebP bug resolved

**IMPORTANT CORRECTION about "two catalogs":** There is only ONE catalog in Meta Commerce Manager. The display name "Products for MercadoBarinas (1199850446786643)" is auto-generated by Meta — the `6643` in the title is decorative (likely WABA or business profile ID), NOT a second catalog. The real catalog ID is `1255972477908976`. Both `catalog_id` values exist in `meta_saas.catalog_products` table (same 15 products in each), but only `1255972477908976` is the real Meta catalog used by the bot and feed.

- **Problem:** Meta Commerce Manager couldn't load products from feed `https://mbtechpanel.mbtech.work/api/catalogs/1255972477908976/feed`. Root causes:
  1. `link` field pointed to `/my-catalogs/{id}` which is behind auth (middleware redirects to login) — Meta scraper got 302 → rejected
  2. `Content-Disposition: attachment` made Meta treat it as a file download instead of inline feed
  3. `Cache-Control: no-store` prevented Meta from re-fetching
  4. Pizza `image_link` used `encrypted-tbn0.gstatic.com` (Google Images cache, unstable URLs that Meta often rejects)
  5. Categories were empty string for extras/refrescos in catalog `1255972477908976` (only had values in new catalog `1199850446786643`)
  6. CSV values not quoted → potential parsing issues
- **Fix applied to `app/api/catalogs/[catalogId]/feed/route.ts`:**
  - Removed `link` field from CSV (not required for WhatsApp Commerce Catalog)
  - Changed `Content-Disposition` to `inline`
  - Changed `Cache-Control` to `public, max-age=300, must-revalidate`
  - All CSV values now quoted with double quotes (escapeCsv wraps all values)
  - `brand` default changed from `mbtech` to `MBTech` (capitalized)
- **Pizza images uploaded to Supabase Storage** (replacing Google Images URLs):
  - `pizza-maragarita-01`: `pizza_margarita_1784320484.jpeg` (54KB, 687×447)
  - `pizza-maragarita-02`: `pizza_albahaca_1784320484.jpg` (54KB, 500×334, from Unsplash)
  - Updated `image_url` in BOTH catalogs (`1255972477908976` and `1199850446786643`)
- **Categories synced** from new catalog `1199850446786643` to old `1255972477908976` (13 products updated): now all have `Pizza`, `Refresco`, or `Extra`
- **Feed validated**: 15 products, all required headers present, all fields populated
- **CRITICAL — App not approved for Catalog API:** App `1723073642211098` ("wasap") returns error `(#100) This application has not been approved to use this api` when calling `graph.facebook.com/v20.0/{catalog_id}` or `/{catalog_id}/product_feeds`. This means:
  - ❌ Cannot use Graph API Batch to upload products programmatically
  - ❌ Cannot query catalog status/feeds via API
  - ✅ CAN use feed CSV method (Meta Commerce Manager UI fetches the URL, no API approval needed)
  - TODO: Submit app for `catalog_management` permission review in Meta App Dashboard to enable API access
- **Feed URL (public, no auth):** `https://mbtechpanel.mbtech.work/api/catalogs/1255972477908976/feed`
- **Next steps for user to complete in Meta Commerce Manager:**
  1. Go to https://business.facebook.com/commerce/catalogs/1255972477908976/content
  2. Click "Add Products" → "Use feed" (or "Add feed")
  3. Set feed URL: `https://mbtechpanel.mbtech.work/api/catalogs/1255972477908976/feed`
  4. Set schedule: hourly (recommended for fresh product updates)
  5. Upload type: "Scheduled feed" (Meta will fetch periodically)
  6. Wait 5-15 min for Meta to validate and load products

### Jul 17, 2026 (later) — WhatsApp móvil freeze on catalog_message back button + WebP fix
- **Problem:** When client opens `catalog_message` (native Meta catalog) in WhatsApp **móvil** and presses left arrow (back), WhatsApp freezes/hangs. Does NOT happen in WhatsApp Web.
- **Root cause:** `refresco-agua-01` (Agua Mineral 500ml) had `image_url` pointing to a `.webp` image in Supabase. WhatsApp móvil has limited/broken WebP support in native Commerce Catalog — causes caching issues when closing catalog view.
- **Fix applied:**
  - User converted the WebP image to JPG and uploaded to Supabase: `1784329955470_akn5l.jpg` (10KB, `image/jpeg`)
  - Updated `image_url` in `meta_saas.catalog_products` for `refresco-agua-01` in BOTH catalog_ids (`1255972477908976` and `1199850446786643`)
  - Set `synced_to_meta=false` so Meta re-syncs the new image
- **Feed image URL strategy changed (by user in another session):**
  - Feed `route.ts` now uses proxy URLs: `https://mbtechpanel.mbtech.work/api/catalogs/{catalogId}/images/{retailer_id}` instead of direct Supabase URLs
  - This endpoint does a 307 redirect to the actual Supabase image URL
  - Reason (from code comment): "evitar caracteres extraños (@, timestamps) que congelan WhatsApp en móviles"
  - All 15 image proxy URLs verified working (200, correct content-type)
  - Also removed `category` field from CSV (Meta rejects custom category values that don't match their taxonomy)
- **Final image format distribution:** 14 JPEG + 1 PNG (Malta Morena `28nxp.png`) + 0 WebP
- **PENDING:** User needs to force "Refresh feed" in Meta Commerce Manager UI (https://business.facebook.com/commerce/catalogs/1255972477908976/content) so Meta re-fetches the feed with the new JPG image for Agua Mineral
- **NOTE:** App `1723073642211098` still NOT approved for Catalog API — cannot trigger re-sync programmatically. Must be done manually in Commerce Manager.

### Jul 27, 2026 — DECISION: Bot commerce funciona SIN catálogo nativo
- **Estado final:** El bot commerce funciona con **flujo conversacional LLM + análisis de IA**, **SIN catálogo nativo** (catalog_message). El catálogo nativo de Meta fue pausado indefinidamente por el freeze en WhatsApp móvil al presionar "back".
- **Causa del freeze (no resuelta):** Después de múltiples intentos (WebP→JPG, cambio de thumbnail a pizza, URLs directas de Supabase, campo `link` en feed), el freeze al presionar left arrow en WhatsApp móvil persiste. No ocurre en WhatsApp Web. Es probablemente un bug del cliente de WhatsApp móvil con catalog_message nativo. El usuario decidió no seguir investigando y usar el flujo conversacional LLM en su lugar.
- **Feed CSV sigue activo** en `https://mbtechpanel.mbtech.work/api/catalogs/1255972477908976/feed` para futura reactivación del catálogo nativo cuando Meta/WhatsApp fixee el bug del móvil.
- **Cambios aplicados al feed `route.ts` durante la investigación (quedan en producción):**
  - `image_link`: URL directa de Supabase (sin proxy)
  - `link`: igual a `image_link` (workaround para evitar error de Meta que requiere link válido)
  - Sin campo `category` (Meta rechaza valores custom)
  - `custom_label_0` para agrupación visual (Platos Principales, Agregados, Bebidas, Postres)
  - Ordenamiento: Pizza → Extra → Bebida
- **Endpoint product page creado** (`app/api/catalogs/[catalogId]/product/[retailerId]/route.ts`) — sirve HTML público con info del producto y botón "Pedir por WhatsApp". No se usa actualmente (link=image_link) pero queda disponible.
- **Middleware actualizado** para permitir rutas públicas `/product/` y `/images/`.
- **aiService.js:** `catalog_message` nativo sigue en el código (2 puntos: saludo + re-envío tras agregar producto) con fallback en `quickSend`. El thumbnail usa `mainDishes[0]` (pizza) en el saludo. El usuario puede haber modificado el código con GPT — no verificar sin confirmar.
- **Imágenes en Supabase Storage:** 14 JPEG + 1 PNG (Malta Morena), 0 WebP. Todas accesibles públicamente.
- **Catálogos en BD:** Ambos `catalog_id` (`1255972477908976` y `1199850446786643`) tienen los mismos 15 productos con las mismas URLs de imagen. Solo `1255972477908976` es el catálogo real de Meta.

### Jul 27, 2026 — quickSend fallback for catalog_message (botwaba)
- **Problem:** When `catalog_message` is rejected by Meta (e.g. "Products not found in FB Catalog" error 131009), `quickSend` didn't retry with fallback, causing the bot to send nothing → client rewrites → loop ("parpadeo continuo").
- **Fix applied to `aiService.js` (botwaba) `quickSend` function:**
  - When `interactivePayload.type === 'catalog_message'`, pre-builds a fallback list payload via `getInteractiveMenuPayload()` and queues it as second attempt
  - If Meta rejects catalog_message (non-200), automatically retries with the interactive list (or plain text if list also fails)
  - Uses a `for` loop over `payloadsToSend = [catalogMessagePayload, fallbackList]`
  - On first success, breaks and persists the message
- **Known bug in fallback (NOT YET FIXED):** `catalogId is not defined` error in fallback because `catalogId` is declared with `const` (line 789) AFTER `quickSend` definition (line 667). The `const` is not hoisted, so when `quickSend` calls `getInteractiveMenuPayload(pgPool, catalogId, ...)` the variable is in TDZ. Logs show: `[COMMERCE] Fallback list build error: catalogId is not defined`. The fallback to interactive list NEVER works — it falls through to plain text. TODO: move `catalogId` declaration before `quickSend` or use `var`.

## 1. Server & Environment Details
- **VPS IP Address:** `45.134.226.235`
- **SSH User:** `root`
- **PostgreSQL:** `postgresql://postgres:G3CPFnfZ9ia5Hvn@127.0.0.1:54322/postgres`
  - Schema `meta_saas`: CRM tables (saas_clients, wabas, phones, catalogs, catalog_products, catalog_store_settings, conversations, messages, contacts, media_library, etc.)
  - Schema `botwaba`: bot tables (clientes_bot, commerce_sessions, commerce_businesses, pedidos, company_knowledge, company_profiles, global_business_templates, token_usage_log, tasas_cambio)
  - Schema `public`: tasas_cambio (BCV rates)
- **Supabase URL:** `https://metasupa.mbtech.work`
- **Supabase Anon Key:** `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzU0NjA1MTE3LCJleHAiOjE3ODYxNDExMTd9.4i_y4EaOJU_x3v-NJb5mdWxqFnjH4dyQZ3xVT_8qdeY`
- **Redis:** Container `chatwoot-redis-1` on port 6379, password: `0e8c41011636eb514a908426a27460b2bd96e6fedae35a3f4142d0860843b1e1`
  - `REDIS_URL=redis://:0e8c41011636eb514a908426a27460b2bd96e6fedae35a3f4142d0860843b1e1@127.0.0.1:6379`
- **Ably API Key:** `ujbrcw.Pr2nug:HnMVo8Jtp8qozEAduo7cdE-ZpkyHX3pTEnYDhaFjQ6Q`
- **OpenRouter API Key:** `sk-or-v1-...` (Configurada en variables de entorno `.env` / `.env.local`)
- **Default AI Model:** `google/gemma-4-31b-it` ($0.06/$0.33 per 1M tokens)
- **Internal API Secret (crm-saas ↔ botwaba):** `mbtech_internal_rag_123`
- **META_ACCESS_TOKEN:** `EAAYfIFhdpxoBRZCTZCT7xtaUhYeImDZBwlSxTsLg3zEPZBKt9PgMS63QcRJGaIIcPpIkVYjmJRLb7s3ZC5VWiCdwgNrcmxMWiW7nn5usCRySBBoaLEXlTMcguQCFQOppWK4hBajnCAUncT3YRRRGebg0qDeKVq44orAzfFFzXZCtN3McfNXjWi5HeF2ieHzz41wAZDZD`
- **CRM Admin Login:** user `admin@mbtech.work`, password `Garcialv1959/` (set Jul 16, 2026, in `.env.local` ADMIN_PASSWORD)
- **Meta Tech Provider:** MBTech approved as Tech Provider. App ID `1723073642211098`, Business ID `1047109242354157`.

## 2. Active PM2 Processes & Startup Commands
When the server restarts or the PM2 daemon clears, these are the correct paths and commands to run/restart the services:

### CRM / Panel (crm-saas)
- **Production Directory on Server:** `/root/crm-saas`
- **PM2 Name:** `crm-saas`
- **Port:** `3005` (Mandatory, mapped in Nginx)
- **Env file:** `/root/crm-saas/.env.local`
- **Command to Start:** `cd /root/crm-saas && PORT=3005 pm2 start npm --name crm-saas -- start`
- **Command to Rebuild & Redeploy:** `cd /root/crm-saas && npm run build && PORT=3005 pm2 restart crm-saas`

### BotWaba Bridge (botwaba)
- **Production Directory on Server:** `/root/botwaba`
- **PM2 Name:** `botwaba`
- **Port:** `4000`
- **Env file:** `/root/botwaba/.env`
- **Command to Start:** `cd /root/botwaba && pm2 start server.js --name botwaba`
- **Command to Restart:** `pm2 restart botwaba --update-env && pm2 save`

*Note: Always execute `pm2 save` after modifications to persist the process list on system reboots.*

## 3. Nginx Routing Rules
- `https://mbtechpanel.mbtech.work` → `localhost:3005` (crm-saas)
- `/api/crm/` and `/api/onboarding/` → `localhost:4000` (botwaba)
- `https://webhook.mbtech.work` → crm-saas `/api/webhooks`

## 4. Bot Architecture

### Routing (aiService.js)
Bot messages arrive via Meta webhook → crm-saas `app/api/webhooks/route.ts` → forwards to botwaba `localhost:4000/api/internal/bot-webhook` with payload: `{ recipient, message, phoneNumberId, wabaId, accessToken, userId, conversationId, match_key, button_payload, match_type, context, messageType, messageText, mediaUrl, location, rawPayload }`

`aiService.js` routes by `bot_module_type` from `botwaba.clientes_bot`:
- `disabled` → no response
- `taxi` → forwards raw payload to `https://taxibot.mbtech.work/webhook` (separate server)
- `commerce` → **LLM conversacional** (OpenRouter) with catalog + state injection (NOT state machine anymore)
- `basic_qa` (default) → LLM (OpenRouter) with RAG context from `botwaba.company_knowledge`
- `retail_delivery` → LLM with AIDA sales prompt + RAG
- `appointments` → LLM with booking prompt + RAG
- `lead_gen` → LLM with lead capture prompt + RAG

### Bot Config Location
- `botwaba.clientes_bot` table: `bot_module_type`, `is_delivery_enabled`, `address_details` (jsonb), `payment_pago_movil` (jsonb), `commerce_settings` (jsonb: `{catalog_id, currency, delivery_fee, min_order_value, admin_phones}`)
- `botwaba.commerce_businesses` table (NEW): multi-negocio config per inbox_id
- `meta_saas.saas_clients` table: `company_name`, `business_nature`, `whatsapp_number`, `subscription_plan`, `balance_due`, `status`, `inbox_id`

## 5. Commerce Bot (LLM-driven, NOT state machine)

### Architecture
The commerce bot is now **LLM-driven** (not a deterministic state machine). The flow is:
1. **CASO 0 (Multi-negocio router):** If `commerce_businesses` has >1 business for this inbox_id, show list. Client selects → `business_id` saved in session.
2. **CASO 1 (Comprobante detection):** If client sends image + word "pago"/"capture" OR context has payment info in last 5 bot messages → create pedido automatically + ask "¿Estás seguro?"
3. **CASO 2 (Confirmation):** If session.state === 'WAITING_CONFIRMATION' and client says "Sí" → confirm pedido + show ETA. "No" → cancel.
4. **CASO 3 (LLM flow):** Load menu from catalog_products grouped by category → build prompt → call OpenRouter → respond.

### "En construcción" check
If a business has no `catalog_id`, the bot responds: "🏗️ [business_name] está en construcción. Escribe *negocios* para ver otras opciones."

### Multi-negocio (NEW)
- Table `botwaba.commerce_businesses`: one WABA number can host multiple businesses
- Client writes "hola" → sees list of businesses → selects one → emparejado until pedido complete or "negocios" command
- Each business has its own: catalog_id, payment_pago_movil, admin_phones, delivery_fee, address
- Backward compatible: if no businesses configured for inbox_id, falls back to `clientes_bot` config (tech provider mode)

### Admin commands (WhatsApp del vendedor)
- `pendientes` → shows pending orders WITH comprobante photo + business_name
- `confirmar 1-7` or `confirmar ORD-000001-07` → marks as paid, notifies client
- `enviado 1-7` → marks as shipped, sends admin phone to client ("desligue")
- `listo 1-7` → marks as ready for pickup
- `rechazar 1-7` → marks as rejected, notifies client
- Order number normalization: admin can write `1-7`, `000001-07`, `ORD-000001-07` — all variants work

### Comprobante flow (no [PEDIDO_CONFIRMADO] tag)
- Client sends image with word "pago"/"capture" → CASO 1 detects (by keyword OR context)
- Bot creates pedido in `botwaba.pedidos` with `proof_media_url`, `business_id`
- Bot asks "¿Estás seguro?" → client says "Sí" → confirmed
- Order number format: `ORD-000001-07` (6-digit seq + 2-digit month)
- ETA disclaimer: 30 min pickup, 45 min delivery
- If admin doesn't respond in 30 min → cron notifies admin + client with admin phone

### Token logging
- Every LLM call logs to `botwaba.token_usage_log` (input_tokens, output_tokens, cost_usd, latency_ms)
- Cost: $0.06/1M input + $0.33/1M output (gemma-4-31b-it)
- Average per sale: ~9,300 tokens, ~$0.0007 IA cost

### `quickSend` in aiService.js
- Signature: `quickSend(text, imageUrl)` — sends `type: "image"` if imageUrl provided, else `type: "text"`
- Persists to `meta_saas.messages` + notifies Ably for CRM real-time UI

### `sendToPhone` (admin commands)
- Sends to specific phone (admin or client) + persists to correct conversation + Ably
- Resolves client conversation by `phone_number_id + customer_phone`

### Database Tables
- `botwaba.commerce_sessions`: `(id, inbox_id, customer_phone, state, cart, cart_meta, current_item, delivery_type, delivery_address, order_total_usd, bcv_rate, proof_media_url, business_id, created_at, updated_at)`
- `botwaba.commerce_businesses` (NEW): `(id, inbox_id, business_name, business_nature, catalog_id, emoji, payment_pago_movil, admin_phones, delivery_fee, is_delivery_enabled, address_street, address_city, is_active, sort_order, created_at)`
- `botwaba.pedidos`: `(order_number, inbox_id, customer_phone, items, subtotal_usd, delivery_fee_usd, total_usd, total_bs, bcv_rate, delivery_type, delivery_address, payment_info, proof_media_url, status, business_id)`
  - Statuses: pending → paid → shipped → ready (or rejected/cancelled)
- `botwaba.token_usage_log`: `(id, inbox_id, customer_phone, conversation_id, module, model, input_tokens, output_tokens, total_tokens, cost_usd, latency_ms, created_at)`
- `meta_saas.catalog_products`: `(id, catalog_id, user_id, retailer_id, title, description, price, currency, image_url, availability, category, synced_to_meta, ts)` — UNIQUE(catalog_id, retailer_id)
  - Categories: "Pizza", "Refresco", "Extra"/"Agregado"/"Adicional" (for extras)
- `public.tasas_cambio`: `(id, codigo_divisa, monto_tasa, fecha_vigencia, fecha_registro)` — BCV rates

### BCV Rate Scraper (bcvScraper.js)
- Uses `https.get` with `rejectUnauthorized: false` to scrape `https://www.bcv.org.ve/`
- Searches within `id="dolar"` section for `<strong class="strong-tb">721,34560000</strong>`
- Converts European format (comma decimal) to float: `721,34560000` → `721.3456`
- Cache: Redis 30 min → BD `public.tasas_cambio` → fallback returns 0 (no hardcoded rate)
- `setRedisClient()` and `setPgPool()` must be called at init
- Current rate: ~721.35 Bs/$ (Jul 2026)

### Webhook (app/api/webhooks/route.ts)
- Accepts: text, image, audio, button, interactive, **location** (NEW)
- Location payload: `{ latitude, longitude, name, address }` passed to botwaba
- Location saved in `pedidos.delivery_address` as "Name (lat:X, lng:Y)"
- "Vaciar chat" button (trash icon) in ConversationView.tsx → DELETE messages for conversation

### CRM (CRMDashboardClient.tsx)
- Bot module dropdown: `basic_qa`, `commerce`, `retail_delivery`, `appointments`, `lead_gen`, `taxi`, `disabled`
- "WhatsApp del Vendedor" field: visible when bot_module_type === 'commerce' → saves to `commerce_settings.admin_phones`
- commerce_settings is loaded from client on edit and merged (not overwritten) on save

## 6. Active Configuration (as of Jul 16, 2026)

### WABA
- `waba_id`: `2109313352968146`
- `user_id`: `admin@mbtech.work`
- `phone_id` (inbox_id): `1213848621804009`
- WhatsApp number: `+58 424 591 33 70`

### Meta Tech Provider (NEW Jul 16)
- MBTech approved as Meta Tech Provider
- App ID: `1723073642211098`
- Business ID: `1047109242354157`
- Native Meta Commerce catalog integration enabled

### Commerce Bot Config
- `bot_module_type`: `commerce`
- `commerce_settings`: `{"currency":"USD","catalog_id":"1255972477908976","delivery_fee":2.00,"min_order_value":5.00,"admin_phones":["584225913370"]}`
- `payment_pago_movil`: `{"rif":"V-12345678","banco":"Bancamiga","bank_code":"0172","telefono":"0414-1234567","phone":"0414-1234567","cedula":"V-12345678","nombre_titular":"MBTech C.A."}`

### Multi-negocio (commerce_businesses)
- 3 businesses for inbox_id `1213848621804009`:
  1. 🍕 Pizzeria mbtech (catalog_id: `1199850446786643` NEW native Meta catalog, `is_active=true`, sort_order: 1)
  2. 🍔 Hamburguesería El Rey (no catalog_id, `is_active=false`, sort_order: 2)
  3. 🌯 Shawarma Express (no catalog_id, `is_active=false`, sort_order: 3)

### Catalogs — TWO catalog_ids in DB (both with 15 products)
- **`1199850446786643`** (NEW — active, used by `commerce_businesses` for Pizzeria mbtech): proper `category` values (`Pizza`, `Refresco`, `Extra`), `image_url` NULL (pending upload)
- **`1255972477908976`** (OLD — still in `meta_saas.catalogs` and `commerce_settings.catalog_id`): categories were empty strings for extras/refrescos, same 15 products

### Catalog products (same 15 products in both catalogs)
- 2 Pizzas: Margarita $10, Margarita con albahaca $12
- 10 Refrescos: Coca-Cola 500ml $2, Coca-Cola 1.5L $4, Pepsi 500ml $2, Pepsi 1.5L $4, Fanta Naranja $2, Fanta Uva $2, Sprite $2, Malta Morena $2.50, Jugo de Naranja Natural $3, Agua Mineral $1.50
- 3 Extras: Queso Extra $1.50, Tocineta $2, Borde de Queso $3

### Admin phones
- `584225913370` (Griskmon — tests admin commands)

### Client test phone
- `584245913370` (Luis Ramón García — tests client flow)

## 7. Deploy Workflow

### To deploy CRM changes (this repo → server):
```bash
scp app/api/webhooks/route.ts root@45.134.226.235:/root/crm-saas/app/api/webhooks/route.ts
scp app/crm/CRMDashboardClient.tsx root@45.134.226.235:/root/crm-saas/app/crm/CRMDashboardClient.tsx
ssh root@45.134.226.235 "cd /root/crm-saas && npm run build && PORT=3005 pm2 restart crm-saas && pm2 save"
```

### To deploy botwaba changes:
```bash
# Upload .js files via scp
scp file.js root@45.134.226.235:/root/botwaba/file.js
# Restart (no build needed — plain Node.js)
ssh root@45.134.226.235 "pm2 restart botwaba --update-env && pm2 save"
```

### To clear Redis cache + sessions for testing:
```bash
ssh root@45.134.226.235 "redis-cli -a 0e8c41011636eb514a908426a27460b2bd96e6fedae35a3f4142d0860843b1e1 DEL inbox:1213848621804009:config 2>/dev/null && PGPASSWORD='G3CPFnfZ9ia5Hvn' psql 'postgresql://postgres@127.0.0.1:54322/postgres' -c \"DELETE FROM botwaba.commerce_sessions WHERE inbox_id='1213848621804009'\" && pm2 restart botwaba --update-env && pm2 save && pm2 flush botwaba"
```

### To verify botwaba logs:
```bash
ssh root@45.134.226.235 "pm2 logs botwaba --lines 30 --nostream"
```
Should NOT show: `supabaseUrl is required`, `NOAUTH`, `database "postgresMETA_..." does not exist`, `Cannot access 'activeCatalogId' before initialization`

## 8. Business Model (MBTech as tech provider + vendedor)

### Pricing model
- **Abono mensual:** $20/mes ($10/mes primeros 3 meses con 50% descuento)
- **Comisión:** 15% de la ganancia extra generada por el bot (cobrada al final del mes)
- **Garantía:** Si no recupera el abono en el primer mes, devolución
- **El cliente paga Meta directo** (MBtech no absorba el costo de Meta)

### Cost structure
- IA (OpenRouter gemma-4): ~$0.0007 por venta
- Meta WhatsApp: ~$0.023 por venta (23 mensajes outbound × $0.001)
- Total por venta: ~$0.024
- Capital para arrancar con 3 clientes: **$5** (el resto se autofinancia con el flujo de ventas)

### ROI
- Con 1 cliente (8 ventas/día extra): $204/mes ganancia para MBtech
- Con 50 clientes: $10,189/mes
- Con 100 clientes: $20,378/mes
- ROI: 1,433% (con 15% comisión)

## 9. Known Issues & Fixes Applied

### Fixed: .env corruption in botwaba (Jul 10)
- `POSTGRES_URL` was concatenated with `META_ACCESS_TOKEN` (missing newline)
- `REDIS_URL` was missing entirely → Redis NOAUTH errors
- Fixed by rewriting `/root/botwaba/.env` with correct line breaks + Redis URL

### Fixed: quickSend not persisting messages (Jul 10)
- `quickSend` only sent to Meta Graph API but didn't INSERT into `meta_saas.messages`
- Fixed: now does `INSERT INTO messages` + Ably notification

### Fixed: token_usage_log INSERT (Jul 12)
- Had 10 columns but only 9 values ($1-$9, missing $10)
- Fixed: added $10 for latency_ms

### Fixed: BCV scraper grabbing EUR instead of USD (Jul 12)
- Regex was grabbing first `<strong>` in HTML (which is EUR)
- Fixed: now searches within `id="dolar"` section specifically

### Fixed: commerce_settings overwritten when saving admin_phones (Jul 12)
- CRM frontend was overwriting entire commerce_settings JSON when saving admin_phones
- Fixed: handleEdit now loads existing commerce_settings and merges

### Fixed: CASO 0 ordering — BUSINESS_SELECT processed before list display (Jul 12)
- Client selected business but bot showed list again instead of menu
- Fixed: process BUSINESS_SELECT state first, then show list if no business_id

### Fixed: activeCatalogId used before initialization (Jul 12)
- `const catalogId = activeCatalogId` was before `activeCatalogId` was defined
- Fixed: moved catalogId definition after all active* vars

### UNFIXED: 7 bugs in aiService.js commerce flow (Jul 16) — causes "problema tecnico" errors
1. **BUG #1 (FATAL):** `activeDeliveryFee` undefined at aiService.js:581. When client selects "Para Delivery", `quickSend` uses `activeDeliveryFee` which doesn't exist in scope. Correct var is `bizDeliveryFee`. Throws ReferenceError → catch → "Lo siento, tuve un problema tecnico".
2. **BUG #2 (FATAL):** `adminPhones` out of scope at aiService.js:746. In CASO 2 (client answers "Sí" to comprobante confirmation), `adminPhones` is referenced but was declared with `let` inside the admin commands block (line 318) which does `return` early. Not visible in CASO 2 scope. Throws ReferenceError → "problema tecnico".
3. **BUG #3:** `totalBs` doesn't include delivery fee (aiService.js:725). `totalBs = totalUsd * orderRate` where `totalUsd` is subtotal ($24), but the message shows `$26` (subtotal + delivery). Bs. amount is wrong.
4. **BUG #4:** `action_finish_order` doesn't add delivery fee to `order_total_usd` saved in session (aiService.js:604). Session saves subtotal only, but CASO 1 comprobante uses `totalUsd + deliveryFee` for display. Inconsistency.
5. **BUG #5:** `isDelivery` always false in CASO 2 (aiService.js:744). `pendingItem = JSON.parse(session.current_item)` only has `{order_number, proof_media_url}`, no `delivery_type`. ETA always 30 min even for delivery orders (should be 45).
6. **BUG #6:** Emoji `U0001F4B3` malformed at aiService.js:601. Literal string `U0001F4B3` shown to client instead of 💳. Should be `\u{1F4B3}` or the emoji literal.
7. **BUG #7 (latent):** `paymentPagoMovil` undefined at aiService.js:598. `const pm = activePaymentMovil || paymentPagoMovil || {}` — `paymentPagoMovil` doesn't exist. Works today because `activePaymentMovil` is truthy, but latent ReferenceError if it ever is empty.

## 10. Pending / Future Work

### PWA external app with conversational chatbot (EXPLORATION — not decided)
- Idea: WhatsApp as entry point → redirect to PWA → PWA hosts chatbot with rich UI (carruseles, formularios, upload, sin límites de Meta)
- Pros: catálogo visual rico, sin restricciones de Meta (10 rows, 3 botones), fuera de ventana 24h, menos tokens LLM
- Cons: fricción para clientes WhatsApp-nativos, consumo de datos, mantenimiento duplicado
- Alternativa: PWA solo para admin/vendedor (cliente sigue en WhatsApp)
- Estado: en idea, no codificar todavía

### CRM: New page /businesses (PENDING)
- New page to create/edit/activate commerce_businesses
- Fields: business_name, business_nature, catalog_id, emoji, payment_pago_movil, admin_phones, delivery_fee, is_delivery_enabled, address
- Toggle is_active to show/hide business from client list

### Product image upload (file picker)
- Current: CatalogManagerClient uses manual URL input for image_url
- Planned: file picker with 500x500px validation, upload to Supabase bucket
- quickSend already supports imageUrl parameter

### Meta Commerce Catalog integration (STARTED — native catalog access enabled Jul 16)
- MBTech is now Meta Tech Provider (approved)
- Native Meta Commerce catalog access enabled
- catalog_id `1199850446786643` created in Meta Commerce Manager, products synced
- Would enable WhatsApp `product_message` type with thumbnails in lists (card format with image)
- TODO: update `commerce_settings.catalog_id` from `1255972477908976` (old) to `1199850446786643` (new native) in `clientes_bot`
- TODO: upload product images to `catalog_products.image_url` (currently NULL)

### RAG for product search (not started)
- Currently using ILIKE for hardware mode
- Could add embeddings + RPC `match_catalog_products` for semantic search

### Estimated delivery time by statistics (future)
- Currently uses fixed 30 min (pickup) / 45 min (delivery)
- Could calculate average from historical order data

### Stale order cron (implemented but needs testing)
- setInterval checks every 5 min for orders pending >30 min
- Notifies admin + client with admin phone if stale
- Uses Redis flag to avoid duplicate notifications (1h TTL)