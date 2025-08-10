#!/bin/bash

# Multi-node test setup for bolt blockchain
# This script starts all 3 nodes in separate docker-compose environments

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # no color

# Function to print colored output
print_status() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

print_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

print_warning() {
    echo -e "${YELLOW}[WARNING]${NC} $1"
}

print_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

# Function to check if a port is in use
check_port() {
    local port=$1
    if lsof -i :$port > /dev/null 2>&1; then
        return 0  # port is in use
    else
        return 1  # port is free
    fi
}

# Function to wait for a service to be ready
wait_for_service() {
    local url=$1
    local name=$2
    local max_attempts=30
    local attempt=0

    print_status "waiting for $name to be ready at $url..."
    
    while [ $attempt -lt $max_attempts ]; do
        if curl -s $url > /dev/null 2>&1; then
            print_success "$name is ready!"
            return 0
        fi
        
        attempt=$((attempt + 1))
        echo -n "."
        sleep 2
    done
    
    print_error "$name failed to start within $(($max_attempts * 2)) seconds"
    return 1
}

# Function to cleanup resources
cleanup() {
    print_status "cleaning up resources..."
    
    # stop all nodes
    cd docker/node1 && docker-compose down -v > /dev/null 2>&1 || true
    cd ../node2 && docker-compose down -v > /dev/null 2>&1 || true  
    cd ../node3 && docker-compose down -v > /dev/null 2>&1 || true
    cd ../../
    
    # remove shared network if it exists
    docker network rm bolt-shared-network > /dev/null 2>&1 || true
    
    print_success "cleanup completed"
}

# Function to start all nodes
start_nodes() {
    print_status "starting multi-node bolt blockchain setup..."
    
    # create shared network for inter-node communication
    print_status "creating shared network for inter-node communication..."
    docker network create bolt-shared-network > /dev/null 2>&1 || {
        print_warning "shared network already exists"
    }
    
    # start node 1 (bootstrap miner)
    print_status "starting node 1 (bootstrap miner)..."
    cd docker/node1
    docker-compose up -d
    cd ../../
    
    # wait for node 1 to be ready
    wait_for_service "http://localhost:7333/blockchain/info" "node 1"
    wait_for_service "http://localhost:5001/api/v0/version" "node 1 IPFS"
    
    # start node 2 (miner)
    print_status "starting node 2 (miner)..."
    cd docker/node2
    docker-compose up -d
    cd ../../
    
    # wait for node 2 to be ready
    wait_for_service "http://localhost:7343/blockchain/info" "node 2"
    wait_for_service "http://localhost:5011/api/v0/version" "node 2 IPFS"
    
    # start node 3 (full node)
    print_status "starting node 3 (full node)..."
    cd docker/node3
    docker-compose up -d
    cd ../../
    
    # wait for node 3 to be ready
    wait_for_service "http://localhost:7353/blockchain/info" "node 3"
    wait_for_service "http://localhost:5021/api/v0/version" "node 3 IPFS"
    
    print_success "all nodes are running!"
}

# Function to show node status
show_status() {
    echo ""
    print_status "node status:"
    echo "  node 1 (miner): http://localhost:7333"
    echo "  node 2 (miner): http://localhost:7343" 
    echo "  node 3 (full):  http://localhost:7353"
    echo ""
    print_status "IPFS status:"
    echo "  node 1 IPFS: http://localhost:5001"
    echo "  node 2 IPFS: http://localhost:5011"
    echo "  node 3 IPFS: http://localhost:5021"
    echo ""
    
    # show blockchain status for each node
    print_status "blockchain status:"
    for port in 7333 7343 7353; do
        local node_name
        case $port in
            7333) node_name="node 1" ;;
            7343) node_name="node 2" ;;
            7353) node_name="node 3" ;;
        esac
        
        local info=$(curl -s "http://localhost:$port/blockchain/info" 2>/dev/null || echo "{}")
        local height=$(echo "$info" | grep -o '"height":[0-9]*' | cut -d: -f2 || echo "0")
        echo "  $node_name: height $height"
    done
    echo ""
}

# Function to run basic connectivity tests
test_connectivity() {
    print_status "running connectivity tests..."
    
    # test API endpoints
    for port in 7333 7343 7353; do
        local node_name
        case $port in
            7333) node_name="node 1" ;;
            7343) node_name="node 2" ;;
            7353) node_name="node 3" ;;
        esac
        
        if curl -s "http://localhost:$port/blockchain/info" > /dev/null; then
            print_success "$node_name API is responding"
        else
            print_error "$node_name API is not responding"
        fi
    done
    
    # test IPFS endpoints
    for port in 5001 5011 5021; do
        local node_name
        case $port in
            5001) node_name="node 1 IPFS" ;;
            5011) node_name="node 2 IPFS" ;;
            5021) node_name="node 3 IPFS" ;;
        esac
        
        if curl -s "http://localhost:$port/api/v0/version" > /dev/null; then
            print_success "$node_name is responding"
        else
            print_error "$node_name is not responding"
        fi
    done
}

# Main script logic
case "${1:-start}" in
    "start")
        # check for port conflicts
        for port in 6379 6389 6399 4001 4011 4021 5001 5011 5021 7333 7343 7353 8080 8090 8100; do
            if check_port $port; then
                print_warning "port $port is already in use - this may cause conflicts"
            fi
        done
        
        start_nodes
        show_status
        test_connectivity
        
        echo ""
        print_success "multi-node setup complete!"
        print_status "to stop all nodes, run: $0 stop"
        print_status "to view logs, run: $0 logs"
        print_status "to check status, run: $0 status"
        ;;
        
    "stop")
        cleanup
        ;;
        
    "status")
        show_status
        test_connectivity
        ;;
        
    "logs")
        print_status "showing logs from all nodes (ctrl+c to exit)..."
        echo ""
        
        # show logs from all nodes in parallel
        (cd docker/node1 && docker-compose logs -f --tail=10) &
        (cd docker/node2 && docker-compose logs -f --tail=10) &
        (cd docker/node3 && docker-compose logs -f --tail=10) &
        
        wait
        ;;
        
    "restart")
        print_status "restarting all nodes..."
        cleanup
        sleep 2
        start_nodes
        show_status
        test_connectivity
        ;;
        
    "help"|"--help"|"-h")
        echo "bolt multi-node test script"
        echo ""
        echo "usage: $0 [command]"
        echo ""
        echo "commands:"
        echo "  start    start all nodes (default)"
        echo "  stop     stop all nodes and cleanup"
        echo "  status   show node status and connectivity"
        echo "  logs     show logs from all nodes"
        echo "  restart  restart all nodes"
        echo "  help     show this help message"
        echo ""
        echo "ports:"
        echo "  node 1: API 7333, IPFS 5001, Redis 6379"
        echo "  node 2: API 7343, IPFS 5011, Redis 6389"
        echo "  node 3: API 7353, IPFS 5021, Redis 6399"
        ;;
        
    *)
        print_error "unknown command: $1"
        echo "run '$0 help' for usage information"
        exit 1
        ;;
esac