import os
from dotenv import load_dotenv
from supabase import create_client, Client, ClientOptions
from neo4j import GraphDatabase, Driver
from postgrest import APIResponse, APIError

load_dotenv()

# Neo4j connection setup
URI = os.environ.get("NEO4J_URI")
AUTH = (os.environ.get("NEO4J_USER"), os.environ.get("NEO4J_PASSWORD"))

# Verify connectivity to Neo4j
driver: Driver = GraphDatabase.driver(URI, auth=AUTH)
driver.verify_connectivity()

# Supabase connection setup
url: str = os.environ.get("SUPABASE_URL")
key: str = os.environ.get("SUPABASE_KEY")
supabase: Client = create_client(url, key, options=ClientOptions(postgrest_client_timeout=30))

def fetch_valid_account_ids() -> set[str]:
    """
    Fetch all valid account_ids from the 'account' table,
    so we can discard any follower references not in the database.
    """
    response: APIResponse = supabase.table("account").select("account_id").execute()

    # Build a set of valid IDs
    valid_ids: set[str] = {row["account_id"] for row in response.data if "account_id" in row}
    print(f"Number of valid account IDs fetched: {len(valid_ids)}")  # Log the valid IDs
    return valid_ids

def fetch_follower_relationships(valid_ids: set[str]) -> list[dict]:
    """
    Fetch rows from the 'followers' table where either:
      - account_id is in [user_id_1, user_id_2], or
      - follower_account_id is in [user_id_1, user_id_2].
    This ensures we collect all follower relationships touching these two users.
    """
    try:
        response: APIResponse = supabase.table("followers") \
            .select("account_id, follower_account_id") \
            .in_("account_id", valid_ids) \
            .in_("follower_account_id", valid_ids) \
            .execute()
    except APIError as e:
        raise RuntimeError(f"Follower query failed: {str(e)}") from e
    
    print(f"Number of follower relationships fetched: {len(response.data)}")
    return response.data

def insert_relationships_into_neo4j(relationships: list[dict], valid_ids: set[str]) -> None:
    """
    Create nodes and edges in Neo4j. 
    The direction of the edge should be from followed -> follower.
    """
    print(f"Number of valid IDs inside insert_relationships_into_neo4j: {len(valid_ids)}") # Log valid_ids
    with driver.session() as session:
        # Create a unique constraint on :User(id) to avoid duplicates (optional, but recommended)
        session.run("CREATE CONSTRAINT IF NOT EXISTS FOR (u:User) REQUIRE (u.id) IS UNIQUE")

        tx = session.begin_transaction()  # Start a transaction
        try:
            for row in relationships:
                followed_id: str = row["account_id"]
                follower_id: str = row["follower_account_id"]

                # Discard if either user not in valid_ids
                if followed_id not in valid_ids or follower_id not in valid_ids:
                    print(f"Skipping invalid relationship: {followed_id} -> {follower_id}")
                    continue

                # Use MERGE to upsert the nodes and relationship
                cypher = """
                MERGE (followed:User {id: $followed_id})
                MERGE (follower:User {id: $follower_id})
                MERGE (followed)-[:FOLLOWED_BY]->(follower)
                """
                tx.run(
                    cypher,
                    followed_id=followed_id,
                    follower_id=follower_id
                )
                print(f"Inserted relationship: {followed_id} -> {follower_id}")
            tx.commit()  # Commit the transaction
            print("Transaction committed successfully.")
        except Exception as e:
            tx.rollback()  # Rollback in case of error
            print(f"Transaction rolled back due to error: {e}")
        finally:
            tx.close()  # Always close the transaction

def main() -> None:
    # 1. Fetch valid account IDs
    valid_ids: set[str] = fetch_valid_account_ids()

    # 2. Fetch all follower relationships that touch either user
    relationships: list[dict] = fetch_follower_relationships(valid_ids)

    # 3. Insert them into Neo4j with direction (followed -> follower)
    insert_relationships_into_neo4j(relationships, valid_ids)

    print("Done! Check your Neo4j database for the new graph data.")

if __name__ == "__main__":
    main()
    driver.close()