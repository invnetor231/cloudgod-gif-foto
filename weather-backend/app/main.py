from datetime import datetime, timezone
from fastapi import FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.providers import cptec, gfs, inmet

app = FastAPI(
    title="CLOUDGOD Weather API",
    version="0.1.0",
    description="API inicial para integrar NOAA GFS, CPTEC/INPE e INMET.",
)

# Em produção, substitua * pelos domínios autorizados do painel CLOUDGOD.
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "cloudgod-weather-api", "utc": datetime.now(timezone.utc).isoformat()}


@app.get("/api/providers/status")
async def providers_status():
    return {
        "gfs": gfs.status(),
        "cptec": cptec.status(),
        "inmet": inmet.status(),
        "note": "Status de configuração; não significa que uma previsão já foi obtida.",
    }


@app.get("/api/weather")
async def weather(lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180)):
    """Consulta as fontes configuradas. Cada fonte informa explicitamente se está indisponível."""
    results = await _gather_sources(lat, lon)
    return {
        "location": {"latitude": lat, "longitude": lon},
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "sources": results,
        "warning": "Não combine observações de estação com previsões de modelo como se fossem a mesma coisa.",
    }


async def _gather_sources(lat: float, lon: float):
    return {
        "noaa_gfs": await gfs.fetch(lat, lon),
        "cptec_inpe": await cptec.fetch(lat, lon),
        "inmet": await inmet.fetch(lat, lon),
    }
