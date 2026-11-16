"""CPTEC/INPE provider placeholder."""
async def fetch(lat: float, lon: float) -> dict:
    return {
        "available": False,
        "provider": "CPTEC/INPE",
        "status": "not_implemented",
        "message": "Adaptador do serviço oficial CPTEC ainda precisa ser implementado e validado.",
        "requested_location": {"latitude": lat, "longitude": lon},
    }


def status() -> dict:
    return {"configured": False, "status": "not_implemented"}
