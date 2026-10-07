declare module '@novnc/novnc' {
  export default class RFB {
    constructor(target: HTMLElement, url: string, options?: {shared?: boolean; wsProtocols?: string[]});
    viewOnly: boolean; scaleViewport: boolean; resizeSession: boolean;
    showDotCursor: boolean; focusOnClick: boolean; qualityLevel: number;
    compressionLevel: number; background: string;
    addEventListener(type: string, callback: EventListener): void;
    disconnect(): void; focus(): void; sendKey(key: number, code: string): void;
  }
}
