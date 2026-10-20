data "aws_availability_zones" "available" {
  state = "available"
}

data "aws_ami" "ubuntu" {
  most_recent = true
  owners      = ["099720109477"] # Canonical
  filter {
    name   = "name"
    values = ["ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

resource "aws_vpc" "solvia" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true
  tags = { Name = "solvia-${var.environment}-vpc" }
}
resource "aws_internet_gateway" "internet" {
  vpc_id = aws_vpc.solvia.id
  tags = { Name = "solvia-${var.environment}-igw" }
}
resource "aws_subnet" "public" {
  vpc_id                  = aws_vpc.solvia.id
  cidr_block              = var.subnet_cidr
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true
  tags = { Name = "solvia-${var.environment}-public" }
}
resource "aws_route_table" "public" {
  vpc_id = aws_vpc.solvia.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.internet.id
  }
  tags = { Name = "solvia-${var.environment}-public" }
}
resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}
resource "aws_security_group" "web" {
  name_prefix = "solvia-${var.environment}-web-"
  description = "HTTP/HTTPS publicos; sem SSH publico ou banco de dados exposto"
  vpc_id      = aws_vpc.solvia.id
  ingress {
    description = "ACME e redirecionamento para HTTPS"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    description = "HTTPS publico"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    description = "Atualizacoes, HTTPS Microsoft/SSM e repositorios Docker"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
  tags = { Name = "solvia-${var.environment}-web" }
}
resource "aws_iam_role" "ssm" {
  name_prefix = "solvia-${var.environment}-ssm-"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
    }]
  })
}
resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.ssm.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}
resource "aws_iam_instance_profile" "instance" {
  name_prefix = "solvia-${var.environment}-"
  role        = aws_iam_role.ssm.name
}
resource "aws_instance" "app" {
  ami                         = data.aws_ami.ubuntu.id
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.web.id]
  associate_public_ip_address = true
  iam_instance_profile        = aws_iam_instance_profile.instance.name
  key_name                    = var.ssh_key_name
  user_data                   = file("${path.module}/cloud-init.sh")
  user_data_replace_on_change = false
  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required" # IMDSv2 obrigatório
  }
  root_block_device {
    volume_size = 20
    volume_type = "gp3"
    encrypted   = true
  }
  tags = { Name = "solvia-${var.environment}-app" }
  depends_on = [aws_iam_role_policy_attachment.ssm]
}
