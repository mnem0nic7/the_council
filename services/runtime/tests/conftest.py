from __future__ import annotations

import os
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

TEST_ROOT = Path(tempfile.mkdtemp(prefix="council-runtime-tests-"))
os.environ.setdefault("DATABASE_URL", f"sqlite:///{TEST_ROOT / 'runtime.db'}")
os.environ.setdefault("ARTIFACT_ROOT", str(TEST_ROOT / "artifacts"))
os.environ.setdefault("WORKSPACE_ROOT", str(TEST_ROOT / "workspaces"))
os.environ.setdefault("JWT_SECRET", "test-secret-with-sufficient-length-for-sha256")
os.environ.setdefault("COUNCIL_OPERATOR_USERNAME", "captain")
os.environ.setdefault("COUNCIL_OPERATOR_PASSWORD", "bridge123")

from app.db import Base, SessionLocal, engine
from app.main import app
from app.seed import seed_defaults


@pytest.fixture(autouse=True)
def reset_database() -> None:
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    with SessionLocal() as session:
        seed_defaults(session)
    yield


@pytest.fixture
def client() -> TestClient:
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def auth_headers(client: TestClient) -> dict[str, str]:
    response = client.post(
        "/api/v1/auth/login",
        json={"username": os.environ["COUNCIL_OPERATOR_USERNAME"], "password": os.environ["COUNCIL_OPERATOR_PASSWORD"]},
    )
    token = response.json()["accessToken"]
    return {"Authorization": f"Bearer {token}"}
