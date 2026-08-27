resource "oci_psql_db_system" "production" {
  count = var.enable_database ? 1 : 0

  compartment_id              = var.compartment_id
  db_version                  = "16"
  description                 = "Wathaiqi Health production PostgreSQL for sensitive credential metadata"
  display_name                = "${var.name_prefix}-postgresql"
  instance_count              = var.db_instance_count
  instance_memory_size_in_gbs = 16
  instance_ocpu_count         = 1
  shape                       = "PostgreSQL.VM.Standard.E5.Flex"
  system_type                 = "OCI_OPTIMIZED_STORAGE"
  freeform_tags               = local.common_tags

  credentials {
    username = var.db_admin_username

    password_details {
      password_type  = "VAULT_SECRET"
      secret_id      = var.db_admin_secret_id
      secret_version = var.db_admin_secret_version
    }
  }

  network_details {
    is_reader_endpoint_enabled = false
    nsg_ids                    = [oci_core_network_security_group.database.id]
    subnet_id                  = oci_core_subnet.database.id
  }

  storage_details {
    availability_domain   = local.availability_domain
    is_regionally_durable = false
    system_type           = "OCI_OPTIMIZED_STORAGE"
  }

  management_policy {
    backup_policy {
      backup_start   = "02:00"
      kind           = "DAILY"
      retention_days = 35
    }

    maintenance_window_start = "SUN 03:00"

    pitr_policy {
      kind         = "STANDARD"
      restore_days = 14
    }
  }

  lifecycle {
    prevent_destroy = true

    precondition {
      condition = (
        var.db_admin_secret_id != null &&
        var.db_admin_secret_version != null
      )
      error_message = "Set db_admin_secret_id and db_admin_secret_version before enable_database=true."
    }
  }

  timeouts {
    create = "2h"
    update = "2h"
    delete = "2h"
  }
}

data "oci_psql_db_system_connection_detail" "production" {
  count        = var.enable_database ? 1 : 0
  db_system_id = oci_psql_db_system.production[0].id
}
