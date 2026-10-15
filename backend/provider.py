import json
import asyncio
from collections.abc import AsyncIterator

import httpx

from backend.config import Settings


class ProviderError(Exception):
    """A safe-to-display provider error."""


async def stream_chat(settings: Settings, messages: list[dict[str, str]]) -> AsyncIterator[str]:
    key = settings.llm_api_key.get_secret_value()
    if not key:
        raise ProviderError("The model API key is not configured. Add LLM_API_KEY to .env and restart the server.")

    url = f"{settings.llm_base_url.rstrip('/')}/chat/completions"
    payload = {
        "model": settings.llm_model,
        "messages": [{"role": "system", "content": settings.system_prompt}, *messages],
        "stream": True,
        "max_tokens": settings.max_output_tokens,
    }
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(90, connect=15)) as client:
            for attempt in range(3):
                async with client.stream(
                    "POST", url, headers={"Authorization": f"Bearer {key}"}, json=payload
                ) as response:
                    if response.status_code == 503 and attempt < 2:
                        # Gemini can return brief capacity outages. Retry only before
                        # emitting any tokens, honoring Retry-After when it is numeric.
                        try:
                            delay = float(response.headers.get("retry-after", ""))
                        except ValueError:
                            delay = 2**attempt
                        await asyncio.sleep(max(0.5, min(delay, 8.0)))
                        continue
                    if response.status_code >= 400:
                        # Do not echo provider bodies; they can include account or request details.
                        if response.status_code == 429:
                            raise ProviderError(
                                "The model provider rejected this request with HTTP 429. "
                                "Your account may have reached its usage or billing limit, or requests may be rate limited. "
                                "Check the provider dashboard for API billing, available quota, and rate limits, then try again."
                            )
                        if response.status_code == 503:
                            raise ProviderError(
                                "The model provider is temporarily unavailable (HTTP 503). "
                                "I retried the request; please try again in a little while."
                            )
                        if response.status_code in (401, 403):
                            raise ProviderError(
                                "The model provider rejected the API credentials (HTTP "
                                f"{response.status_code}). Check that LLM_API_KEY is valid for this provider."
                            )
                        if response.status_code == 404:
                            raise ProviderError(
                                "The configured model or API endpoint was not found (HTTP 404). "
                                "Check LLM_BASE_URL and LLM_MODEL in .env."
                            )
                        raise ProviderError(f"Model provider returned HTTP {response.status_code}.")
                    async for line in response.aiter_lines():
                        if not line.startswith("data:"):
                            continue
                        data = line[5:].strip()
                        if data == "[DONE]":
                            break
                        try:
                            event = json.loads(data)
                            delta = event["choices"][0].get("delta", {}).get("content")
                        except (ValueError, KeyError, IndexError, TypeError):
                            continue
                        if isinstance(delta, str) and delta:
                            yield delta
                    break
    except httpx.TimeoutException as exc:
        raise ProviderError("The model provider timed out. Please try again.") from exc
    except httpx.HTTPError as exc:
        raise ProviderError("Could not connect to the model provider. Check the endpoint and try again.") from exc
