export interface DesktopBounds { x: number; y: number; width: number; height: number }
export interface DesktopObserveInput { windowRef?: string; crop?: DesktopBounds; maxWidth?: number }
export interface DesktopActionInput {
  observationId: string; action: 'move' | 'click' | 'scroll' | 'type' | 'key';
  x?: number; y?: number; text?: string; keys?: string[];
  direction?: 'up' | 'down' | 'left' | 'right'; notches?: number;
}
export interface DesktopObservation {
  observationId: string; timestamp: string; windowRef: string; title: string;
  bounds: DesktopBounds; crop: DesktopBounds; width: number; height: number; dpi: number;
  foregroundWindowRef?: string; windows: unknown[]; actionable: boolean; backend: string;
  owned?: boolean; recovery?: 'observe' | 'input'; reason?: string;
  mimeType: 'image/png'; data: string;
  context?: { documentToken: string | null; documentTitle?: string; capturedAt?: string; ageMs?: number; source: 'cached-native-context' };
}
export interface DesktopReceipt { status: 'dispatched' | 'not-dispatched' | 'unknown'; inserted: number; error?: string; owned?: boolean; recovery?: 'observe' | 'input' }
export interface DesktopEvidence extends Omit<DesktopObservation, 'data'> { artifact: string }
export interface DesktopOperation {
  operationId: string; requestId: string; fingerprint: string; input: DesktopActionInput;
  createdAt: string; documentToken: string | null; receipt: DesktopReceipt;
}
export interface DesktopState {
  available: boolean; status: 'idle' | 'preparing' | 'recovering' | 'controlling' | 'paused' | 'unknown' | 'unavailable';
  countdownEndsAt?: number;
  error?: string; latest?: DesktopEvidence; operations: DesktopOperation[];
}
export interface DesktopTools {
  observe(input: DesktopObserveInput, signal?: AbortSignal): Promise<DesktopObservation>;
  action(requestId: string, input: DesktopActionInput, signal?: AbortSignal): Promise<{ receipt: DesktopReceipt; observation?: DesktopObservation; captureError?: string }>;
}
export interface DesktopTransport {
  request(kind: 'start' | 'recover' | 'observe' | 'action', input?: object, requestId?: string): Promise<unknown>;
  stop(): Promise<void>;
  close(): Promise<void>;
  onState?: (state: { owned: boolean; unknown: boolean; inputUnknown?: boolean; error?: string }) => void;
}
