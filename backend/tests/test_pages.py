def test_create_page(client):
    res = client.post("/api/pages", json={"title": "Test Page", "content": "<p>Hello</p>"})
    assert res.status_code == 201
    data = res.json()
    assert data["title"] == "Test Page"
    assert data["content"] == "<p>Hello</p>"
    assert "id" in data


def test_list_pages(client):
    client.post("/api/pages", json={"title": "A"})
    res = client.get("/api/pages")
    assert res.status_code == 200
    assert len(res.json()) == 1


def test_get_page(client):
    create = client.post("/api/pages", json={"title": "Get Me"})
    page_id = create.json()["id"]
    res = client.get(f"/api/pages/{page_id}")
    assert res.status_code == 200
    assert res.json()["title"] == "Get Me"


def test_update_page(client):
    create = client.post("/api/pages", json={"title": "Old"})
    page_id = create.json()["id"]
    res = client.patch(f"/api/pages/{page_id}", json={"title": "New"})
    assert res.status_code == 200
    assert res.json()["title"] == "New"


def test_delete_page(client):
    create = client.post("/api/pages", json={"title": "Delete Me"})
    page_id = create.json()["id"]
    res = client.delete(f"/api/pages/{page_id}")
    assert res.status_code == 204
    res = client.get(f"/api/pages/{page_id}")
    assert res.status_code == 404


def test_get_nonexistent_page(client):
    res = client.get("/api/pages/nonexistent-id")
    assert res.status_code == 404
