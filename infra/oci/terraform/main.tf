data "oci_identity_availability_domains" "riyadh" {
  compartment_id = var.tenancy_id
}

data "oci_core_services" "oracle_services" {
  filter {
    name   = "name"
    values = ["All .* Services In Oracle Services Network"]
    regex  = true
  }
}

data "oci_objectstorage_namespace" "this" {
  compartment_id = var.compartment_id
}

resource "terraform_data" "paid_production_guard" {
  input = var.deployment_profile

  lifecycle {
    precondition {
      condition = (
        var.deployment_profile == "PAID_PRODUCTION" &&
        var.confirm_paid_production == "CREATE_PAID_PRODUCTION"
      )
      error_message = "This Terraform directory is a paid-production reference and is disabled. Set deployment_profile=PAID_PRODUCTION and confirm_paid_production=CREATE_PAID_PRODUCTION only after funding, budget, IAM, and a reviewed plan are approved. FREE_ACCEPTANCE does not provision OCI resources."
    }
  }
}

locals {
  availability_domain = coalesce(
    var.availability_domain,
    data.oci_identity_availability_domains.riyadh.availability_domains[0].name,
  )
  oracle_services = data.oci_core_services.oracle_services.services[0]
  common_tags = {
    application = "wathaiqi-health"
    environment = "production"
    managed-by  = "terraform"
    data-class  = "sensitive-workforce"
  }
}

resource "oci_core_vcn" "production" {
  cidr_blocks    = ["10.42.0.0/16"]
  compartment_id = var.compartment_id
  display_name   = "${var.name_prefix}-vcn"
  dns_label      = "wathaiqi"
  freeform_tags  = local.common_tags

  depends_on = [terraform_data.paid_production_guard]
}

resource "oci_core_internet_gateway" "public" {
  compartment_id = var.compartment_id
  display_name   = "${var.name_prefix}-internet"
  enabled        = true
  vcn_id         = oci_core_vcn.production.id
  freeform_tags  = local.common_tags
}

resource "oci_core_service_gateway" "private_services" {
  compartment_id = var.compartment_id
  display_name   = "${var.name_prefix}-oracle-services"
  vcn_id         = oci_core_vcn.production.id

  services {
    service_id = local.oracle_services.id
  }

  freeform_tags = local.common_tags
}

resource "oci_core_route_table" "public" {
  compartment_id = var.compartment_id
  display_name   = "${var.name_prefix}-public-routes"
  vcn_id         = oci_core_vcn.production.id

  route_rules {
    destination       = "0.0.0.0/0"
    destination_type  = "CIDR_BLOCK"
    network_entity_id = oci_core_internet_gateway.public.id
  }

  freeform_tags = local.common_tags
}

resource "oci_core_route_table" "app_private" {
  compartment_id = var.compartment_id
  display_name   = "${var.name_prefix}-app-private-routes"
  vcn_id         = oci_core_vcn.production.id

  route_rules {
    destination       = local.oracle_services.cidr_block
    destination_type  = "SERVICE_CIDR_BLOCK"
    network_entity_id = oci_core_service_gateway.private_services.id
  }

  freeform_tags = local.common_tags
}

resource "oci_core_route_table" "database_private" {
  compartment_id = var.compartment_id
  display_name   = "${var.name_prefix}-database-private-routes"
  vcn_id         = oci_core_vcn.production.id
  freeform_tags  = local.common_tags
}

resource "oci_core_security_list" "empty" {
  compartment_id = var.compartment_id
  display_name   = "${var.name_prefix}-empty-security-list"
  vcn_id         = oci_core_vcn.production.id
  freeform_tags  = local.common_tags
}

resource "oci_core_subnet" "load_balancer" {
  cidr_block                 = "10.42.0.0/24"
  compartment_id             = var.compartment_id
  display_name               = "${var.name_prefix}-lb-public"
  dns_label                  = "lb"
  prohibit_public_ip_on_vnic = false
  route_table_id             = oci_core_route_table.public.id
  security_list_ids          = [oci_core_security_list.empty.id]
  vcn_id                     = oci_core_vcn.production.id
  freeform_tags              = local.common_tags
}

resource "oci_core_subnet" "app" {
  cidr_block                 = "10.42.10.0/24"
  compartment_id             = var.compartment_id
  display_name               = "${var.name_prefix}-app-private"
  dns_label                  = "app"
  prohibit_public_ip_on_vnic = true
  route_table_id             = oci_core_route_table.app_private.id
  security_list_ids          = [oci_core_security_list.empty.id]
  vcn_id                     = oci_core_vcn.production.id
  freeform_tags              = local.common_tags
}

resource "oci_core_subnet" "database" {
  cidr_block                 = "10.42.20.0/24"
  compartment_id             = var.compartment_id
  display_name               = "${var.name_prefix}-database-private"
  dns_label                  = "db"
  prohibit_public_ip_on_vnic = true
  route_table_id             = oci_core_route_table.database_private.id
  security_list_ids          = [oci_core_security_list.empty.id]
  vcn_id                     = oci_core_vcn.production.id
  freeform_tags              = local.common_tags
}
