import os
from dataclasses import dataclass

@dataclass
class Settings:
    cors_origins: list[str]
    inmet_token: str | None


def _origins() -> list[str]:
    raw = os.getenv("CORS_ORIGINS", "*")
    return [item.strip() for item in raw.split(",") if item.strip()]

settings = Settings(
    cors_origins=_origins(),
    inmet_token=os.getenv("INMET_TOKEN"),
)
