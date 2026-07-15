#!/usr/bin/env python3
"""Keep one OpenAI Whisper model warm and transcribe JSON-line requests."""

from __future__ import annotations

import argparse
import json
import sys
import time
from typing import Any


def emit(payload: dict[str, Any]) -> None:
    print(json.dumps(payload, ensure_ascii=False), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="small.en")
    parser.add_argument("--device", default="cpu")
    args = parser.parse_args()

    import whisper  # Imported after argument parsing so startup errors reach stderr.

    started = time.perf_counter()
    model = whisper.load_model(args.model, device=args.device)
    emit(
        {
            "type": "ready",
            "model": args.model,
            "device": args.device,
            "load_ms": round((time.perf_counter() - started) * 1000),
        }
    )

    for raw_line in sys.stdin:
        request_id = "unknown"
        try:
            request = json.loads(raw_line)
            request_id = str(request["id"])
            file_path = str(request["file_path"])
            language = request.get("language")
            started = time.perf_counter()
            result = model.transcribe(file_path, language=language, verbose=None)
            emit(
                {
                    "type": "result",
                    "id": request_id,
                    "text": str(result.get("text", "")).strip(),
                    "duration_ms": round((time.perf_counter() - started) * 1000),
                }
            )
        except Exception as error:  # Keep serving after one malformed or failed capture.
            emit({"type": "error", "id": request_id, "error": str(error)})

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
