-- Per-gear databases (matches config/postgres.yaml). Runs once on first volume init.
CREATE DATABASE studio_types_registry OWNER studio;
CREATE DATABASE studio_nodes_registry OWNER studio;
CREATE DATABASE studio_resource_group OWNER studio;
CREATE DATABASE studio_account_management OWNER studio;
CREATE DATABASE studio_settings OWNER studio;
CREATE DATABASE studio_file_storage OWNER studio;
CREATE DATABASE studio_mini_chat OWNER studio;
