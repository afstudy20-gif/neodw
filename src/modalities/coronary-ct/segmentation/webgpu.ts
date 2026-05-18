// WebGPU capability probe for coronary tree segmentation scaffold.
//
// Goal: produce a deterministic "can we run on-device neural inference"
// answer at panel-open time, without pulling onnxruntime-web into the
// main bundle.

export interface GpuCapabilities {
  hasWebGpu: boolean;
  hasWebGl2: boolean;
  adapterName?: string;
  adapterVendor?: string;
  maxBufferSize?: number;
  reason?: string;
}

declare global {
  interface Navigator {
    gpu?: {
      requestAdapter: (opts?: unknown) => Promise<GPUAdapter | null>;
    };
  }
  interface GPUAdapter {
    info?: { description?: string; vendor?: string };
    requestDevice: () => Promise<GPUDevice>;
    limits?: { maxBufferSize?: number };
  }
  interface GPUDevice {
    destroy: () => void;
  }
}

export async function probeGpu(): Promise<GpuCapabilities> {
  const result: GpuCapabilities = { hasWebGpu: false, hasWebGl2: false };

  // WebGL2 fallback check
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (gl) {
      result.hasWebGl2 = true;
    }
  } catch {
    // ignore
  }

  if (!navigator.gpu) {
    result.reason = 'navigator.gpu unavailable (Chrome/Edge 113+ required)';
    return result;
  }

  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) {
      result.reason = 'No GPU adapter available';
      return result;
    }
    result.hasWebGpu = true;
    result.adapterName = adapter.info?.description ?? 'unknown';
    result.adapterVendor = adapter.info?.vendor ?? 'unknown';
    result.maxBufferSize = adapter.limits?.maxBufferSize;

    const device = await adapter.requestDevice();
    device.destroy();
    return result;
  } catch (err) {
    result.reason = err instanceof Error ? err.message : 'unknown error';
    return result;
  }
}

export function recommendedBackend(caps: GpuCapabilities): 'webgpu' | 'wasm' | 'unsupported' {
  if (caps.hasWebGpu) return 'webgpu';
  if (caps.hasWebGl2) return 'wasm';
  return 'unsupported';
}
