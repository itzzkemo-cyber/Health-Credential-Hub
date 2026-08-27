resource "oci_load_balancer_load_balancer" "public" {
  compartment_id             = var.compartment_id
  display_name               = "${var.name_prefix}-public"
  is_private                 = false
  network_security_group_ids = [oci_core_network_security_group.load_balancer.id]
  shape                      = "flexible"
  subnet_ids                 = [oci_core_subnet.load_balancer.id]
  freeform_tags              = local.common_tags

  shape_details {
    minimum_bandwidth_in_mbps = 10
    maximum_bandwidth_in_mbps = 100
  }
}
resource "oci_load_balancer_backend_set" "application" {
  health_checker {
    interval_ms         = 10000
    is_force_plain_text = true
    port                = 8080
    protocol            = "HTTP"
    response_body_regex = ""
    retries             = 3
    return_code         = 200
    timeout_in_millis   = 3000
    url_path            = "/api/readyz"
  }

  load_balancer_id = oci_load_balancer_load_balancer.public.id
  name             = "application"
  policy           = "ROUND_ROBIN"
}

resource "oci_load_balancer_hostname" "application" {
  hostname         = var.public_hostname
  load_balancer_id = oci_load_balancer_load_balancer.public.id
  name             = "application-hostname"
}

resource "oci_load_balancer_listener" "https" {
  default_backend_set_name = oci_load_balancer_backend_set.application.name
  hostname_names           = [oci_load_balancer_hostname.application.name]
  load_balancer_id         = oci_load_balancer_load_balancer.public.id
  name                     = "https"
  port                     = 443
  protocol                 = "HTTP"

  connection_configuration {
    idle_timeout_in_seconds = 60
  }

  ssl_configuration {
    certificate_ids         = [var.tls_certificate_id]
    has_session_resumption  = false
    protocols               = ["TLSv1.2", "TLSv1.3"]
    server_order_preference = "ENABLED"
    verify_peer_certificate = false
  }
}
