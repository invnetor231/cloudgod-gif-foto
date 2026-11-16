"""NOAA GFS provider placeholder.

A produção requer selecionar ciclo/previsão no NOMADS, baixar GRIB2 e
extrair os campos com ecCodes/cfgrib. Esta versão não inventa valores.
"""
async def fetch(lat: float, lon: float) -> dict:
    return {
        "available": False,
        "provider": "NOAA GFS / NOMADS",
        "status": "not_implemented",
        "message": "Ingestão e descodificação GRIB2 ainda precisam ser implementadas e testadas.",
        "requested_location": {"latitude": lat, "longitude": lon},
    }


def status() -> dict:
    return {"configured": False, "status": "not_implemented"}
