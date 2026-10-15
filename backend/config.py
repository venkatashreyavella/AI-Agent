from functools import lru_cache

from pydantic import Field, SecretStr
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    llm_api_key: SecretStr = SecretStr("")
    app_access_password: SecretStr = SecretStr("")
    environment: str = "development"
    llm_base_url: str = "https://api.openai.com/v1"
    llm_model: str = "gpt-4o-mini"
    system_prompt: str = (
        "You are a helpful, careful general-purpose assistant. Be clear about uncertainty "
        "and never claim to have used tools or accessed information you have not actually accessed."
    )
    max_input_messages: int = Field(default=40, ge=1, le=100)
    max_message_chars: int = Field(default=20_000, ge=100, le=100_000)
    max_output_tokens: int = Field(default=2048, ge=64, le=16_384)


@lru_cache
def get_settings() -> Settings:
    return Settings()
