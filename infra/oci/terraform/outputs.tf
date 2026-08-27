output "availability_domain" {
  value       = local.availability_domain
  description = "Exact Riyadh AD used for PostgreSQL and Container Instances."
}

output "app_subnet_id" {
  value       = oci_core_subnet.app.id
  description = "Private subnet for a future reviewed release process."
}

output "app_network_security_group_id" {
  value       = oci_core_network_security_group.app.id
  description = "Private app NSG for a future reviewed release process."
}

output "load_balancer_id" {
  value       = oci_load_balancer_load_balancer.public.id
  description = "Load Balancer OCID for a future reviewed release process."
}

output "load_balancer_backend_set_name" {
  value       = oci_load_balancer_backend_set.application.name
  description = "Backend set name for a future reviewed release process."
}

output "load_balancer_ip" {
  value       = oci_load_balancer_load_balancer.public.ip_address_details[0].ip_address
  description = "Squarespace A record target after readiness acceptance."
}

output "object_storage_bucket" {
  value       = oci_objectstorage_bucket.credentials.name
  description = "Private credential bucket name."
}

output "object_storage_endpoint" {
  value       = "https://${data.oci_objectstorage_namespace.this.namespace}.compat.objectstorage.${var.region}.oraclecloud.com"
  description = "S3-compatible Riyadh endpoint."
}

output "object_storage_namespace" {
  value       = data.oci_objectstorage_namespace.this.namespace
  description = "Object Storage namespace; not a secret."
}

output "ocir_repository" {
  value       = oci_artifacts_container_repository.application.display_name
  description = "Private immutable OCIR repository name."
}

output "postgresql_connection_detail" {
  value       = var.enable_database ? data.oci_psql_db_system_connection_detail.production[0] : null
  description = "Private PostgreSQL connection details."
  sensitive   = true
}

output "vault_id" {
  value       = oci_kms_vault.production.id
  description = "Vault for operator-created runtime and database secrets."
}
