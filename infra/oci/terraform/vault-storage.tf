resource "oci_kms_vault" "production" {
  compartment_id = var.compartment_id
  display_name   = "${var.name_prefix}-vault"
  vault_type     = "DEFAULT"
  freeform_tags  = local.common_tags

  depends_on = [terraform_data.paid_production_guard]

  lifecycle {
    prevent_destroy = true
  }
}

resource "oci_kms_key" "production" {
  compartment_id      = var.compartment_id
  display_name        = "${var.name_prefix}-data-key"
  management_endpoint = oci_kms_vault.production.management_endpoint
  protection_mode     = "HSM"
  freeform_tags       = local.common_tags

  key_shape {
    algorithm = "AES"
    length    = 32
  }

  lifecycle {
    prevent_destroy = true
  }
}

resource "oci_identity_policy" "object_storage_kms" {
  compartment_id = var.tenancy_id
  description    = "Allow Riyadh Object Storage to use only the Wathaiqi production key"
  name           = "${var.name_prefix}-object-storage-kms"
  statements = [
    "Allow service objectstorage-${var.region} to use keys in compartment id ${var.compartment_id} where target.key.id = '${oci_kms_key.production.id}'",
  ]
}

resource "oci_objectstorage_bucket" "credentials" {
  access_type           = "NoPublicAccess"
  compartment_id        = var.compartment_id
  is_bucket_key_enabled = true
  kms_key_id            = oci_kms_key.production.id
  name                  = "${var.name_prefix}-production-private"
  namespace             = data.oci_objectstorage_namespace.this.namespace
  object_events_enabled = true
  storage_tier          = "Standard"
  versioning            = "Enabled"
  freeform_tags         = local.common_tags

  depends_on = [oci_identity_policy.object_storage_kms]

  lifecycle {
    prevent_destroy = true
  }
}

resource "oci_artifacts_container_repository" "application" {
  compartment_id = var.compartment_id
  display_name   = "${var.name_prefix}/app"
  is_immutable   = true
  is_public      = false
  freeform_tags  = local.common_tags

  depends_on = [terraform_data.paid_production_guard]
}

resource "oci_identity_dynamic_group" "container_instances" {
  compartment_id = var.tenancy_id
  description    = "Production Container Instances in the dedicated Wathaiqi compartment"
  matching_rule  = "ALL {resource.type = 'computecontainerinstance', resource.compartment.id = '${var.compartment_id}'}"
  name           = "${replace(var.name_prefix, "-", "_")}_container_instances"

  depends_on = [terraform_data.paid_production_guard]
}

resource "oci_identity_policy" "container_registry_pull" {
  compartment_id = var.tenancy_id
  description    = "Allow production Container Instances to pull private OCIR images"
  name           = "${var.name_prefix}-container-registry-pull"
  statements = [
    "Allow dynamic-group ${oci_identity_dynamic_group.container_instances.name} to read repos in compartment id ${var.compartment_id}",
  ]
}
