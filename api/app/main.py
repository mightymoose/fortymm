from fastapi import FastAPI

app = FastAPI(title="FortyMM API")


@app.get("/v1/health")
def health() -> dict:
    return {}
