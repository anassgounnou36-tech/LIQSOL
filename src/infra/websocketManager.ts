import WebSocket from "ws";
import { logger } from "../observability/logger.js";

interface SlotSubscriptionResponse {
  result?: number;
}

interface SlotNotification {
  params?: {
    result?: {
      slot?: number;
    };
  };
}

type WebSocketMessage = SlotSubscriptionResponse | SlotNotification;

export class WebsocketManager {
  private ws?: WebSocket;
  private wsUrl: string;
  private subscriptionId?: number;
  private onSlotCallback?: (slot: number) => void;
  private reconnectTimer?: NodeJS.Timeout;
  private reconnectDelayMs: number;

  constructor(wsUrl: string, reconnectDelayMs = 5000) {
    this.wsUrl = wsUrl;
    this.reconnectDelayMs = reconnectDelayMs;
  }

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);

      this.ws.on("open", () => {
        logger.debug({ wsUrl: this.wsUrl }, "websocket connected");
        resolve();
      });

      this.ws.on("error", (err) => {
        logger.warn({ err, wsUrl: this.wsUrl }, "websocket error");
        reject(err);
      });

      this.ws.on("message", (data: WebSocket.RawData) => {
        try {
          const msg = JSON.parse(data.toString()) as WebSocketMessage;
          
          // Handle subscription confirmation
          if ('result' in msg && msg.result !== undefined) {
            this.subscriptionId = msg.result;
            logger.debug({ subscriptionId: this.subscriptionId }, "slot subscription confirmed");
            return;
          }

          // Handle slot updates
          if ('params' in msg && msg.params?.result?.slot !== undefined) {
            const slot = msg.params.result.slot;
            if (this.onSlotCallback) {
              this.onSlotCallback(slot);
            }
          }
        } catch (err) {
          logger.warn({ err }, "failed to parse websocket message");
        }
      });

      this.ws.on("close", () => {
        logger.debug({ wsUrl: this.wsUrl }, "websocket closed");
        this.scheduleReconnect();
      });
    });
  }

  subscribeSlot(callback: (slot: number) => void): void {
    this.onSlotCallback = callback;
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "slotSubscribe",
        params: []
      }));
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = undefined;
      try {
        await this.connect();
        if (this.onSlotCallback) {
          this.subscribeSlot(this.onSlotCallback);
        }
      } catch (err) {
        logger.warn({ err }, "reconnect failed");
      }
    }, this.reconnectDelayMs);
  }

  close(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.ws) {
      // Unsubscribe before closing
      if (this.subscriptionId !== undefined && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "slotUnsubscribe",
          params: [this.subscriptionId]
        }));
      }
      this.ws.close();
      this.ws = undefined;
    }
  }
}
