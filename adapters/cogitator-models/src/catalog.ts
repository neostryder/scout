// File names shared by multiple repositories cannot establish a source.
export const CATALOG: Record<string, { source: string; family: string }> = {
  "gemma-4-E4B-it-qat-UD-Q4_K_XL.gguf": {
    "source": "hf:unsloth/gemma-4-E4B-it-qat-GGUF",
    "family": "text"
  },
  "gemma-4-E2B-it-qat-UD-Q4_K_XL.gguf": {
    "source": "hf:unsloth/gemma-4-E2B-it-qat-GGUF",
    "family": "text"
  },
  "Gemma-4-12B-uncensored-bf16.Q5_K_M.gguf": {
    "source": "hf:mradermacher/Gemma-4-12B-uncensored-bf16-GGUF",
    "family": "text"
  },
  "nomic-embed-text-v1.5.Q8_0.gguf": {
    "source": "hf:nomic-ai/nomic-embed-text-v1.5-GGUF",
    "family": "embedding"
  },
  "embeddinggemma-2-Q8_0.gguf": {
    "source": "hf:unsloth/embeddinggemma-2-GGUF",
    "family": "embedding"
  },
  "Qwen3-ASR-1.7B-Q8_0.gguf": {
    "source": "hf:handy-computer/Qwen3-ASR-1.7B-gguf",
    "family": "speech"
  },
  "parakeet-tdt-0.6b-v3-Q8_0.gguf": {
    "source": "hf:handy-computer/parakeet-tdt-0.6b-v3-gguf",
    "family": "speech"
  },
  "MOSS-Transcribe-Diarize-Q8_0.gguf": {
    "source": "hf:handy-computer/moss-transcribe-diarize-gguf",
    "family": "speech-diarize"
  }
};
