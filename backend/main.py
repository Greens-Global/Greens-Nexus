from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
import models
from database import engine
from routers import tasks, purchases, reviews, marketing, sop, assets, accounting, operations, unifi, dashboard, requisitions


@asynccontextmanager
async def lifespan(app: FastAPI):
    try:
        models.Base.metadata.create_all(bind=engine)
        print("[startup] DB tables ready")
    except Exception as e:
        print(f"[startup] DB not ready: {e}")
    yield


app = FastAPI(title="Greens Nexus API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "https://vlow2k.github.io",
        "https://nexus.greensglobal.com",
        "https://dev.nexus.greensglobal.com",
    ],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/")
def health():
    return {"status": "ok"}


app.include_router(tasks.router)
app.include_router(purchases.router)
app.include_router(reviews.router)
app.include_router(marketing.router)
app.include_router(sop.router)
app.include_router(assets.router)
app.include_router(accounting.router)
app.include_router(operations.router)
app.include_router(unifi.router)
app.include_router(dashboard.router)
app.include_router(requisitions.router)
