#!/bin/bash

# bolt e2e docker test runner

set -e

echo "======================================"
echo "Bolt Blockchain E2E Docker Test Suite"
echo "======================================"

# colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # no color

# functions
log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# cleanup function
cleanup() {
    log_info "Cleaning up..."
    docker-compose -f docker-compose.e2e.yml down -v
    docker network prune -f
}

# trap cleanup on exit
trap cleanup EXIT

# parse arguments
BUILD_FRESH=false
SKIP_TESTS=false
KEEP_RUNNING=false

while [[ $# -gt 0 ]]; do
    case $1 in
        --build)
            BUILD_FRESH=true
            shift
            ;;
        --skip-tests)
            SKIP_TESTS=true
            shift
            ;;
        --keep-running)
            KEEP_RUNNING=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Usage: $0 [--build] [--skip-tests] [--keep-running]"
            exit 1
            ;;
    esac
done

# check docker is running
if ! docker info > /dev/null 2>&1; then
    log_error "Docker is not running. Please start Docker and try again."
    exit 1
fi

# build images if requested
if [ "$BUILD_FRESH" = true ]; then
    log_info "Building fresh Docker images..."
    docker-compose -f docker-compose.e2e.yml build --no-cache
else
    log_info "Building Docker images..."
    docker-compose -f docker-compose.e2e.yml build
fi

# start services
log_info "Starting services..."
docker-compose -f docker-compose.e2e.yml up -d

# wait for services to be healthy
log_info "Waiting for services to be ready..."
sleep 10

# check service health
log_info "Checking service health..."

# check bootstrap node
if curl -s http://localhost:7333/health > /dev/null; then
    log_info "Bootstrap node API is healthy"
else
    log_error "Bootstrap node API is not responding"
    exit 1
fi

# check miner1
if curl -s http://localhost:7343/health > /dev/null; then
    log_info "Miner1 API is healthy"
else
    log_error "Miner1 API is not responding"
    exit 1
fi

# check miner2
if curl -s http://localhost:7353/health > /dev/null; then
    log_info "Miner2 API is healthy"
else
    log_error "Miner2 API is not responding"
    exit 1
fi

# check fullnode
if curl -s http://localhost:7363/health > /dev/null; then
    log_info "Fullnode API is healthy"
else
    log_error "Fullnode API is not responding"
    exit 1
fi

# run tests if not skipped
if [ "$SKIP_TESTS" = false ]; then
    log_info "Running E2E tests..."
    
    # test 1: check peer connections
    echo ""
    log_info "Test 1: Checking peer connections..."
    sleep 5
    
    BOOTSTRAP_PEERS=$(curl -s http://localhost:7333/network/status | jq -r '.connectedPeers')
    MINER1_PEERS=$(curl -s http://localhost:7343/network/status | jq -r '.connectedPeers')
    MINER2_PEERS=$(curl -s http://localhost:7353/network/status | jq -r '.connectedPeers')
    FULLNODE_PEERS=$(curl -s http://localhost:7363/network/status | jq -r '.connectedPeers')
    
    echo "  Bootstrap: $BOOTSTRAP_PEERS peers"
    echo "  Miner1: $MINER1_PEERS peers"
    echo "  Miner2: $MINER2_PEERS peers"
    echo "  Fullnode: $FULLNODE_PEERS peers"
    
    if [ "$BOOTSTRAP_PEERS" -gt 0 ]; then
        log_info "✓ Bootstrap has peers"
    else
        log_warn "Bootstrap has no peers yet"
    fi
    
    # test 2: submit transaction
    echo ""
    log_info "Test 2: Submitting test transaction..."
    
    TX_RESPONSE=$(curl -s -X POST http://localhost:7333/transactions \
        -H "Content-Type: application/json" \
        -d '{
            "from": "bolt1abc123",
            "to": "bolt1def456",
            "amount": "1000000000",
            "nonce": 0,
            "fee": "1000000"
        }' 2>/dev/null || echo "{}")
    
    if echo "$TX_RESPONSE" | jq -e '.hash' > /dev/null 2>&1; then
        TX_HASH=$(echo "$TX_RESPONSE" | jq -r '.hash')
        log_info "✓ Transaction submitted: $TX_HASH"
    else
        log_warn "Transaction submission returned: $TX_RESPONSE"
    fi
    
    # test 3: check blockchain sync
    echo ""
    log_info "Test 3: Checking blockchain sync..."
    sleep 10
    
    BOOTSTRAP_HEIGHT=$(curl -s http://localhost:7333/blockchain/info | jq -r '.height')
    MINER1_HEIGHT=$(curl -s http://localhost:7343/blockchain/info | jq -r '.height')
    MINER2_HEIGHT=$(curl -s http://localhost:7353/blockchain/info | jq -r '.height')
    FULLNODE_HEIGHT=$(curl -s http://localhost:7363/blockchain/info | jq -r '.height')
    
    echo "  Bootstrap height: $BOOTSTRAP_HEIGHT"
    echo "  Miner1 height: $MINER1_HEIGHT"
    echo "  Miner2 height: $MINER2_HEIGHT"
    echo "  Fullnode height: $FULLNODE_HEIGHT"
    
    # test 4: check metrics
    echo ""
    log_info "Test 4: Checking metrics endpoints..."
    
    if curl -s http://localhost:9464/metrics | grep -q "bolt_blockchain_height"; then
        log_info "✓ Bootstrap metrics available"
    else
        log_warn "Bootstrap metrics not available"
    fi
    
    if curl -s http://localhost:9465/metrics | grep -q "bolt_blockchain_height"; then
        log_info "✓ Miner1 metrics available"
    else
        log_warn "Miner1 metrics not available"
    fi
    
    # test 5: check monitoring stack
    echo ""
    log_info "Test 5: Checking monitoring stack..."
    
    if curl -s http://localhost:9090/-/ready > /dev/null; then
        log_info "✓ Prometheus is ready"
    else
        log_warn "Prometheus is not ready"
    fi
    
    if curl -s http://localhost:3000/api/health > /dev/null; then
        log_info "✓ Grafana is ready"
    else
        log_warn "Grafana is not ready"
    fi
    
    echo ""
    log_info "E2E tests completed!"
fi

# show logs
echo ""
log_info "Recent logs from nodes:"
echo "------------------------"
docker-compose -f docker-compose.e2e.yml logs --tail=10

# keep running if requested
if [ "$KEEP_RUNNING" = true ]; then
    echo ""
    log_info "Services are running. Access points:"
    echo "  Bootstrap API: http://localhost:7333"
    echo "  Miner1 API: http://localhost:7343"
    echo "  Miner2 API: http://localhost:7353"
    echo "  Fullnode API: http://localhost:7363"
    echo "  Prometheus: http://localhost:9090"
    echo "  Grafana: http://localhost:3000 (admin/admin)"
    echo ""
    echo "Press Ctrl+C to stop..."
    
    # remove trap so cleanup doesn't run automatically
    trap - EXIT
    
    # wait for user interrupt
    while true; do
        sleep 1
    done
fi

echo ""
log_info "Done!"