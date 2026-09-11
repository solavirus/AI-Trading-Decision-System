import { EventEmitter } from 'node:events';
import type { BinanceFuturesCredentials } from './binanceFuturesAdapter.js';
import {
  startBinanceFuturesUserDataStream, keepaliveBinanceFuturesUserDataStream,
  closeBinanceFuturesUserDataStream, binanceFuturesUserDataStreamWsUrl, normalizeExchangeOrder,
} from './binanceFuturesAdapter.js';
import type { NormalizedStreamEvent } from './types.js';

/** Sprint 3.6A — Task 38/39: process-local relay from Binance's User Data Stream (per-connection
 * listenKey + WebSocket) to any number of SSE subscribers (server.ts's `/stream` route). One
 * `ConnectionStream` per `connectionId`, reference-counted so opening the Account page in two
 * browser tabs shares a single upstream Binance connection rather than opening two. REST remains the
 * reconciliation truth everywhere this stream's events are consumed (frontend never trusts a stream
 * event as a complete replacement for a fresh REST read) — this module's only job is low-latency
 * delivery of what Binance already pushed, normalized, never fabricated when a field is missing. */

const LISTEN_KEY_KEEPALIVE_MS = 50 * 60 * 1000; // Binance keeps a listenKey alive 60min; refresh at 50min, well inside the margin
const RECONNECT_BASE_DELAY_MS = 2000;
const RECONNECT_MAX_DELAY_MS = 30000;
const IDLE_STOP_DELAY_MS = 30000; // grace period after the last subscriber leaves, before actually tearing down

type StreamStatus = 'CONNECTING' | 'CONNECTED' | 'RECONNECTING' | 'DISCONNECTED';

class ConnectionStream extends EventEmitter {
  private listenKey: string | null = null;
  private ws: WebSocket | null = null;
  private status: StreamStatus = 'DISCONNECTED';
  subscriberCount = 0;
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private stopped = false;

  constructor(private connectionId: string, private creds: BinanceFuturesCredentials) { super(); }

  currentStatus(): StreamStatus { return this.status; }

  private setStatus(s: StreamStatus) {
    this.status = s;
    this.emit('event', { kind: 'STATUS', eventTime: new Date().toISOString(), data: { status: s } } satisfies NormalizedStreamEvent);
  }

  async start() {
    if (this.stopped) return;
    this.setStatus(this.reconnectAttempt > 0 ? 'RECONNECTING' : 'CONNECTING');
    const started = await startBinanceFuturesUserDataStream(this.creds);
    if (!started.ok || this.stopped) { if (!this.stopped) this.scheduleReconnect(); return; }
    this.listenKey = started.listenKey;
    this.connectWs();
    this.scheduleKeepalive();
  }

  private connectWs() {
    if (this.stopped || !this.listenKey) return;
    const url = binanceFuturesUserDataStreamWsUrl(this.creds.environment, this.listenKey);
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch { this.scheduleReconnect(); return; }
    this.ws = ws;
    ws.addEventListener('open', () => { this.reconnectAttempt = 0; this.setStatus('CONNECTED'); });
    ws.addEventListener('message', (ev: MessageEvent) => this.handleMessage(String(ev.data)));
    ws.addEventListener('close', () => { if (!this.stopped) this.scheduleReconnect(); });
    ws.addEventListener('error', () => { /* the 'close' event fires right after and drives reconnection */ });
  }

  private handleMessage(raw: string) {
    let msg: any;
    try { msg = JSON.parse(raw); } catch { return; }
    const eventTime = msg.E ? new Date(msg.E).toISOString() : new Date().toISOString();

    if (msg.e === 'ORDER_TRADE_UPDATE' && msg.o) {
      const o = msg.o;
      // Field mapping verified live 2026-08-10 against Binance's own ORDER_TRADE_UPDATE example plus
      // cross-checked against the existing REST GET /fapi/v1/order shape (Sprint 3.5D-A) this app
      // already trusts — o.s/S/o/q/p/ap/sp/R/ps overlap exactly; o.X (status)/o.z (cumulative filled
      // qty)/o.i (orderId) match the same semantic role as the REST fields they're mapped to below.
      const order = normalizeExchangeOrder({
        orderId: o.i, clientOrderId: o.c, symbol: o.s, status: o.X, side: o.S, positionSide: o.ps,
        type: o.o, origQty: o.q, price: o.p, avgPrice: o.ap, executedQty: o.z, stopPrice: o.sp,
        reduceOnly: o.R, closePosition: o.cp, time: msg.T, updateTime: msg.T,
      });
      this.emit('event', { kind: 'ORDER_UPDATE', eventTime, data: order } satisfies NormalizedStreamEvent);
    } else if (msg.e === 'ACCOUNT_UPDATE' && msg.a) {
      this.emit('event', {
        kind: 'ACCOUNT_UPDATE', eventTime,
        data: {
          reason: msg.a.m || null,
          balances: (msg.a.B || []).map((b: any) => ({ asset: b.a, walletBalance: Number(b.wb), crossWalletBalance: Number(b.cw) })),
          positions: (msg.a.P || []).map((p: any) => ({
            symbol: p.s, positionAmt: Number(p.pa), entryPrice: Number(p.ep), unrealizedPnl: Number(p.up),
            marginType: p.mt || null, positionSide: p.ps || null, breakEvenPrice: p.bep != null ? Number(p.bep) : null,
          })),
        },
      } satisfies NormalizedStreamEvent);
    } else if (msg.e === 'ACCOUNT_CONFIG_UPDATE') {
      this.emit('event', {
        kind: 'ACCOUNT_CONFIG_UPDATE', eventTime,
        data: { symbol: msg.ac?.s || null, leverage: msg.ac?.l != null ? Number(msg.ac.l) : null },
      } satisfies NormalizedStreamEvent);
    }
    // Any other/unrecognized event type (e.g. MARGIN_CALL, listenKeyExpired) is intentionally
    // ignored rather than guessed at — this app's stream consumption is additive-only.
  }

  private scheduleKeepalive() {
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    this.keepaliveTimer = setInterval(() => {
      if (this.listenKey) keepaliveBinanceFuturesUserDataStream(this.creds, this.listenKey).catch(() => {});
    }, LISTEN_KEY_KEEPALIVE_MS);
  }

  private scheduleReconnect() {
    if (this.stopped) return;
    this.setStatus('RECONNECTING');
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, RECONNECT_BASE_DELAY_MS * Math.pow(2, this.reconnectAttempt));
    this.reconnectAttempt++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.start(), delay);
  }

  async stop() {
    this.stopped = true;
    if (this.keepaliveTimer) clearInterval(this.keepaliveTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.ws) { try { this.ws.close(); } catch {} this.ws = null; }
    const key = this.listenKey;
    this.listenKey = null;
    if (key) await closeBinanceFuturesUserDataStream(this.creds, key).catch(() => {});
    this.setStatus('DISCONNECTED');
  }
}

const streams = new Map<string, ConnectionStream>();
const idleTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** Task 38 — the one entry point server.ts's SSE route uses. Reuses an already-running stream for
 * this connectionId if one exists (reference-counted); starts a fresh one otherwise. Returns an
 * unsubscribe function — the caller (the SSE route) must call it on client disconnect (`req.close`)
 * so an abandoned browser tab doesn't leak a listenKey/WebSocket forever. The stream itself is only
 * actually torn down (listenKey closed) after `IDLE_STOP_DELAY_MS` with zero subscribers, so a quick
 * page navigation/reload doesn't pay the full reconnect cost. */
export function subscribeUserDataStream(connectionId: string, creds: BinanceFuturesCredentials, onEvent: (e: NormalizedStreamEvent) => void): () => void {
  const idleTimer = idleTimers.get(connectionId);
  if (idleTimer) { clearTimeout(idleTimer); idleTimers.delete(connectionId); }

  let stream = streams.get(connectionId);
  if (!stream) {
    stream = new ConnectionStream(connectionId, creds);
    streams.set(connectionId, stream);
    stream.start();
  }
  stream.subscriberCount++;
  stream.on('event', onEvent);
  // A subscriber that joins mid-connection sees the CURRENT status immediately, rather than waiting
  // indefinitely for the next status transition to happen to fire.
  onEvent({ kind: 'STATUS', eventTime: new Date().toISOString(), data: { status: stream.currentStatus() } });

  let unsubscribed = false;
  return () => {
    if (unsubscribed) return;
    unsubscribed = true;
    const s = streams.get(connectionId);
    if (!s) return;
    s.subscriberCount--;
    s.off('event', onEvent);
    if (s.subscriberCount <= 0) {
      const t = setTimeout(() => { s.stop(); streams.delete(connectionId); idleTimers.delete(connectionId); }, IDLE_STOP_DELAY_MS);
      idleTimers.set(connectionId, t);
    }
  };
}
