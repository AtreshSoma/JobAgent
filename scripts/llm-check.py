"""Connectivity check for the optional LLM assist provider.

Reads the key from the environment ONLY. Never hardcode a key in this file: it
lives in the repo tree, and a literal key here is one `git add -A` away from
being published.

Set it in .env (gitignored) or your shell:

    NVIDIA_API_KEY=nvapi-...              # .env
    $env:NVIDIA_API_KEY = "nvapi-..."     # PowerShell, current session

Then:  python scripts/llm-check.py
"""
import os
import sys

try:
    from openai import OpenAI, APIError, AuthenticationError
except ImportError:
    sys.exit(
        "The 'openai' package is not installed.\n"
        "It is an OPTIONAL dependency, used only by the LLM assist layer:\n"
        "    pip install -r requirements-llm.txt"
    )

API_KEY = os.getenv("NVIDIA_API_KEY", "")
BASE_URL = os.getenv("LLM_BASE_URL", "https://integrate.api.nvidia.com/v1")
MODEL = os.getenv("LLM_MODEL", "nvidia/nemotron-3-ultra-550b-a55b")

if not API_KEY:
    sys.exit(
        "NVIDIA_API_KEY is not set.\n"
        "Add it to .env (gitignored) or export it in your shell, then re-run.\n"
        "This script intentionally has no fallback key."
    )

print(f"Connecting to {BASE_URL}")
print(f"Model: {MODEL}")

client = OpenAI(base_url=BASE_URL, api_key=API_KEY)

try:
    completion = client.chat.completions.create(
        model=MODEL,
        messages=[{"role": "user", "content": "Reply with exactly: API key is working."}],
        temperature=0,
        max_tokens=64,
        stream=True,
    )

    print("Connection established. Streaming response:\n")
    for chunk in completion:
        if not chunk.choices:
            continue
        content = chunk.choices[0].delta.content
        if content is not None:
            print(content, end="", flush=True)

    print("\n\nResult: API key verification successful.")

except AuthenticationError:
    sys.exit("\nResult: verification FAILED - invalid key or unauthorized access.")
except APIError as exc:
    sys.exit(f"\nResult: API error - {exc}")
except Exception as exc:  # noqa: BLE001 - a connectivity probe should report anything
    sys.exit(f"\nResult: unexpected error - {exc}")
