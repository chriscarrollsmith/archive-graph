import os
from dotenv import load_dotenv
from supabase import create_client, Client, ClientOptions
from neo4j import GraphDatabase, Driver
from postgrest import APIResponse, APIError

load_dotenv()

# Neo4j connection setup
URI = os.environ.get("VITE_NEO4J_URI")
AUTH = (os.environ.get("VITE_NEO4J_USER"), os.environ.get("VITE_NEO4J_PASSWORD"))

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
    print(f"Number of valid account IDs fetched: {len(valid_ids)}")
    
    return valid_ids

def fetch_account_details(valid_ids: set[str]) -> dict[str, dict]:
    """
    Fetch account details (username, display name, bio, location, avatar) for valid IDs.
    Joins 'account' and 'all_profile' tables.
    """
    try:
        response: APIResponse = supabase.table("account") \
            .select("account_id, username, account_display_name, all_profile(bio, location, avatar_media_url)") \
            .in_("account_id", list(valid_ids)) \
            .execute()
    except APIError as e:
        raise RuntimeError(f"Account details query failed: {str(e)}") from e

    account_details = {}
    for row in response.data:
        account_id = row["account_id"]
        # Handle the nested structure due to the join
        profile_data = row.get("all_profile") or {}  # Default to empty dict if null
        account_details[account_id] = {
            "username": row["username"],
            "account_display_name": row["account_display_name"],
            "bio": profile_data.get("bio"),  # Use .get() for potentially missing keys
            "location": profile_data.get("location"),
            "avatar_media_url": profile_data.get("avatar_media_url"),
        }
    print(f"Number of account details fetched: {len(account_details)}")
    return account_details

def fetch_follower_relationships(valid_ids: set[str]) -> list[dict]:
    """
    Fetch rows from the 'followers' table where either:
      - account_id is in [user_id_1, user_id_2], or
      - follower_account_id is in [user_id_1, user_id_2].
    This ensures we collect all follower relationships touching these two users.
    """    
    try:
        # Convert valid_ids to list and ensure they're strings
        valid_id_list = [str(id) for id in valid_ids]
        
        all_relationships = []
        page = 0
        page_size = 1000
        
        while True:
            response: APIResponse = supabase.table("followers") \
                .select("account_id, follower_account_id") \
                .in_("account_id", valid_id_list) \
                .in_("follower_account_id", valid_id_list) \
                .range(page * page_size, (page + 1) * page_size - 1) \
                .execute()
                
            current_batch = response.data
            all_relationships.extend(current_batch)
            
            # If we got less than page_size results, we've hit the end
            if len(current_batch) < page_size:
                break
                
            page += 1
            print(f"Fetched page {page} ({len(current_batch)} relationships)")
            
        print(f"\nTotal number of follower relationships fetched: {len(all_relationships)}")
        
        # Debug: Print first few results
        print("\nFirst 5 relationships found:")
        for i, row in enumerate(all_relationships[:5]):
            print(f"{i+1}. {row['account_id']} -> {row['follower_account_id']}")
            
        return all_relationships
        
    except APIError as e:
        raise RuntimeError(f"Follower query failed: {str(e)}") from e

def insert_relationships_into_neo4j(relationships: list[dict], valid_ids: set[str], account_details: dict[str, dict]) -> None:
    """
    Create nodes and edges in Neo4j, including user details.
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

                # Get details for followed and follower users.  Use .get() with defaults.
                followed_details = account_details.get(followed_id, {})
                follower_details = account_details.get(follower_id, {})

                # Use MERGE to upsert the nodes and relationship
                cypher = """
                MERGE (followed:User {id: $followed_id})
                SET followed.username = $followed_username,
                    followed.account_display_name = $followed_display_name,
                    followed.bio = $followed_bio,
                    followed.location = $followed_location,
                    followed.avatar_media_url = $followed_avatar_url
                MERGE (follower:User {id: $follower_id})
                SET follower.username = $follower_username,
                    follower.account_display_name = $follower_display_name,
                    follower.bio = $follower_bio,
                    follower.location = $follower_location,
                    follower.avatar_media_url = $follower_avatar_url
                MERGE (followed)-[:FOLLOWED_BY]->(follower)
                """
                tx.run(
                    cypher,
                    followed_id=followed_id,
                    follower_id=follower_id,
                    followed_username=followed_details.get("username"),
                    followed_display_name=followed_details.get("account_display_name"),
                    followed_bio=followed_details.get("bio"),
                    followed_location=followed_details.get("location"),
                    followed_avatar_url=followed_details.get("avatar_media_url"),
                    follower_username=follower_details.get("username"),
                    follower_display_name=follower_details.get("account_display_name"),
                    follower_bio=follower_details.get("bio"),
                    follower_location=follower_details.get("location"),
                    follower_avatar_url=follower_details.get("avatar_media_url")
                )
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

    # 2. Fetch account details
    account_details: dict[str, dict] = fetch_account_details(valid_ids)

    # 3. Fetch all follower relationships that touch either user
    relationships: list[dict] = fetch_follower_relationships(valid_ids)

    # 4. Insert them into Neo4j with direction (followed -> follower)
    insert_relationships_into_neo4j(relationships, valid_ids, account_details)

    print("Done! Check your Neo4j database for the new graph data.")

if __name__ == "__main__":
    main()
    driver.close()