"""Optional CUDA inference with one same-model CPU fallback per batch."""
import os
from pathlib import Path
import sys
_dll_handles = []


def preload_cuda(ort):
    # A venv can reuse the host's installed NVIDIA libraries without importing its
    # Python packages or mixing CPU and GPU onnxruntime distributions.
    if os.name == 'nt':
        import ctypes
        roots = (Path(sys.base_prefix), Path(sys.prefix))
        folders = []
        for root in roots:
            for component in ('cuda_runtime', 'nvjitlink', 'cufft', 'cublas', 'cudnn'):
                folder = root / 'Lib/site-packages/nvidia' / component / 'bin'
                if folder.is_dir():
                    folders.append(folder)
                    _dll_handles.append(os.add_dll_directory(str(folder)))
        for name in ('cudart64_12.dll', 'nvJitLink_120_0.dll', 'cufft64_11.dll',
                     'cublasLt64_12.dll', 'cublas64_12.dll', 'cudnn64_9.dll'):
            source = next((p / name for p in reversed(folders) if (p / name).is_file()), None)
            if source:
                _dll_handles.append(ctypes.WinDLL(str(source)))
    else:
        ort.preload_dlls()


class FallbackEngine:
    def __init__(self, build, prefer_cuda):
        self.build = build
        self.fallback = False
        try:
            self.engine, self.provider = build(prefer_cuda)
        except Exception:
            if not prefer_cuda:
                raise
            self.engine, self.provider = build(False)
            self.fallback = True
        if prefer_cuda and self.provider != 'CUDAExecutionProvider':
            self.fallback = True

    @property
    def tokenizer(self):
        return self.engine.tokenizer

    def create(self, *args, **kwargs):
        try:
            return self.engine.create(*args, **kwargs)
        except Exception:
            if self.provider != 'CUDAExecutionProvider':
                raise
            # Keep the exact FP32 model/voice: its audio cache identity is unchanged.
            self.engine = None
            self.engine, self.provider = self.build(False)
            self.fallback = True
            return self.engine.create(*args, **kwargs)
