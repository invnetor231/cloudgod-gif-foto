"""INMET observations provider placeholder."""
from app.config import settings

async def fetch(lat: float, lon: float) -> dict:
    if not settings.inmet_token:
        return {
            "available": False,
            "provider": "INMET",
            "status": "missing_credentials",
            "message": "Configure INMET_TOKEN no Render se o endpoint utilizado exigir credencial.",
            "requested_location": {"latitude": lat, "longitude": lon},
        }
    return {
        "available": False,
        "provider": "INMET",
        "status": "not_implemented",
        "message": "Consulta de estações, seleção da estação próxima e ingestão observacional ainda precisam ser implementadas.",
        "requested_location": {"latitude": lat, "longitude": lon},
    }


def status() -> dict:
    return {"configured": bool(settings.inmet_token), "status": "credentials_present" if settings.inmet_token else "missing_credentials"}
