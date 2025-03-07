import { createReducer, PayloadAction } from '@reduxjs/toolkit'
import { OrderID } from 'api/gnosisProtocol'
import { SupportedChainId as ChainId } from 'constants/chains'
import {
  addPendingOrder,
  preSignOrders,
  updatePresignGnosisSafeTx,
  removeOrder,
  clearOrders,
  fulfillOrder,
  OrderStatus,
  updateLastCheckedBlock,
  expireOrder,
  fulfillOrdersBatch,
  expireOrdersBatch,
  cancelOrder,
  cancelOrdersBatch,
  requestOrderCancellation,
  SerializedOrder,
  setIsOrderUnfillable,
} from './actions'
import { ContractDeploymentBlocks } from './consts'
import { Writable } from 'types'

export interface OrderObject {
  id: OrderID
  order: SerializedOrder
}

type V2Order = Omit<OrderObject['order'], 'inputToken' | 'outputToken'>

// Previous order state, to use in checks
// in case users have older, stale state and we need to handle
export interface V2OrderObject {
  id: OrderObject['id']
  order: V2Order
}

// {order uuid => OrderObject} mapping
type OrdersMap = Record<OrderID, OrderObject>
export type PartialOrdersMap = Partial<OrdersMap>

export type OrderLists = {
  pending: PartialOrdersMap
  presignaturePending: PartialOrdersMap
  fulfilled: PartialOrdersMap
  expired: PartialOrdersMap
  cancelled: PartialOrdersMap
}

export interface OrdersStateNetwork extends OrderLists {
  lastCheckedBlock: number
}

export type OrdersState = {
  readonly [chainId in ChainId]?: OrdersStateNetwork
}

export interface PrefillStateRequired {
  chainId: ChainId
}

export type OrderTypeKeys = 'pending' | 'presignaturePending' | 'expired' | 'fulfilled' | 'cancelled'
export const ORDER_LIST_KEYS: OrderTypeKeys[] = ['pending', 'presignaturePending', 'expired', 'fulfilled', 'cancelled']
export const ORDERS_LIST: OrderLists = {
  pending: {},
  presignaturePending: {},
  fulfilled: {},
  expired: {},
  cancelled: {},
}

function getDefaultLastCheckedBlock(chainId: ChainId): number {
  return ContractDeploymentBlocks[chainId] ?? 0
}

export function getDefaultNetworkState(chainId: ChainId): OrdersStateNetwork {
  return {
    ...ORDERS_LIST,
    lastCheckedBlock: getDefaultLastCheckedBlock(chainId),
  }
}

// makes sure there's always an object at state[chainId], state[chainId].pending | .fulfilled
function prefillState(
  state: Writable<OrdersState>,
  { payload: { chainId } }: PayloadAction<PrefillStateRequired>
): asserts state is Required<OrdersState> {
  const stateAtChainId = state[chainId]

  if (!stateAtChainId) {
    state[chainId] = getDefaultNetworkState(chainId)
    return
  }

  // Assign default values for order lists in case they are missing
  ORDER_LIST_KEYS.forEach((key) => {
    if (!stateAtChainId[key]) {
      stateAtChainId[key] = ORDERS_LIST[key]
    }
  })

  if (stateAtChainId.lastCheckedBlock === undefined) {
    stateAtChainId.lastCheckedBlock = getDefaultLastCheckedBlock(chainId)
  }
}

function getOrderById(state: Required<OrdersState>, chainId: ChainId, id: string) {
  const stateForChain = state[chainId]
  return (
    stateForChain.pending[id] ||
    stateForChain.presignaturePending[id] ||
    stateForChain.cancelled[id] ||
    stateForChain.fulfilled[id] ||
    stateForChain.expired[id]
  )
}

function deleteOrderById(state: Required<OrdersState>, chainId: ChainId, id: string) {
  const stateForChain = state[chainId]
  delete stateForChain.pending[id]
  delete stateForChain.fulfilled[id]
  delete stateForChain.presignaturePending[id]
  delete stateForChain.expired[id]
  delete stateForChain.cancelled[id]
}

const initialState: OrdersState = {}

export default createReducer(initialState, (builder) =>
  builder
    .addCase(addPendingOrder, (state, action) => {
      prefillState(state, action)
      const { order, id, chainId } = action.payload

      const orderStateList = order.status === OrderStatus.PRESIGNATURE_PENDING ? 'presignaturePending' : 'pending'
      state[chainId][orderStateList][id] = { order, id }
    })
    .addCase(preSignOrders, (state, action) => {
      prefillState(state, action)
      const { ids, chainId } = action.payload
      const pendingOrders = state[chainId].pending

      ids.forEach((id) => {
        const orderObject = getOrderById(state, chainId, id)

        if (orderObject) {
          deleteOrderById(state, chainId, id)

          orderObject.order.status = OrderStatus.PENDING
          pendingOrders[id] = orderObject
        }
      })
    })
    .addCase(updatePresignGnosisSafeTx, (state, action) => {
      prefillState(state, action)
      const { orderId, chainId, safeTransaction } = action.payload

      const orderObject = getOrderById(state, chainId, orderId)
      if (orderObject) {
        orderObject.order.presignGnosisSafeTx = safeTransaction
      }
    })
    .addCase(removeOrder, (state, action) => {
      prefillState(state, action)
      const { id, chainId } = action.payload
      deleteOrderById(state, chainId, id)
    })
    .addCase(fulfillOrder, (state, action) => {
      prefillState(state, action)
      const { id, chainId, fulfillmentTime, transactionHash } = action.payload
      const orderObject = getOrderById(state, chainId, id)

      if (orderObject) {
        deleteOrderById(state, chainId, id)

        orderObject.order.status = OrderStatus.FULFILLED
        orderObject.order.fulfillmentTime = fulfillmentTime

        orderObject.order.fulfilledTransactionHash = transactionHash
        orderObject.order.isCancelling = false

        state[chainId].fulfilled[id] = orderObject
      }
    })
    .addCase(fulfillOrdersBatch, (state, action) => {
      prefillState(state, action)
      const { ordersData, chainId } = action.payload

      // if there are any newly fulfilled orders
      // update them
      ordersData.forEach(({ id, fulfillmentTime, transactionHash, apiAdditionalInfo }) => {
        const orderObject = getOrderById(state, chainId, id)

        if (orderObject) {
          deleteOrderById(state, chainId, id)

          orderObject.order.status = OrderStatus.FULFILLED
          orderObject.order.fulfillmentTime = fulfillmentTime

          orderObject.order.fulfilledTransactionHash = transactionHash
          orderObject.order.isCancelling = false

          orderObject.order.apiAdditionalInfo = apiAdditionalInfo

          state[chainId].fulfilled[id] = orderObject
        }
      })
    })
    .addCase(expireOrder, (state, action) => {
      prefillState(state, action)
      const { id, chainId } = action.payload

      const orderObject = getOrderById(state, chainId, id)

      if (orderObject) {
        deleteOrderById(state, chainId, id)

        orderObject.order.status = OrderStatus.EXPIRED
        orderObject.order.isCancelling = false

        state[chainId].expired[id] = orderObject
      }
    })
    .addCase(expireOrdersBatch, (state, action) => {
      prefillState(state, action)
      const { ids, chainId } = action.payload
      const fulfilledOrders = state[chainId].expired

      // if there are any newly fulfilled orders
      // update them
      ids.forEach((id) => {
        const orderObject = getOrderById(state, chainId, id)

        if (orderObject) {
          deleteOrderById(state, chainId, id)

          orderObject.order.status = OrderStatus.EXPIRED
          orderObject.order.isCancelling = false
          fulfilledOrders[id] = orderObject
        }
      })
    })
    .addCase(requestOrderCancellation, (state, action) => {
      prefillState(state, action)
      const { id, chainId } = action.payload

      const orderObject = getOrderById(state, chainId, id)

      if (orderObject) {
        orderObject.order.isCancelling = true
      }
    })
    .addCase(cancelOrder, (state, action) => {
      prefillState(state, action)
      const { id, chainId } = action.payload

      const orderObject = getOrderById(state, chainId, id)

      if (orderObject) {
        deleteOrderById(state, chainId, id)

        orderObject.order.status = OrderStatus.CANCELLED
        orderObject.order.isCancelling = false

        state[chainId].cancelled[id] = orderObject
      }
    })
    .addCase(cancelOrdersBatch, (state, action) => {
      prefillState(state, action)
      const { ids, chainId } = action.payload
      const cancelledOrders = state[chainId].cancelled

      ids.forEach((id) => {
        const orderObject = getOrderById(state, chainId, id)

        if (orderObject) {
          deleteOrderById(state, chainId, id)

          orderObject.order.status = OrderStatus.CANCELLED
          orderObject.order.isCancelling = false
          cancelledOrders[id] = orderObject
        }
      })
    })
    .addCase(clearOrders, (state, action) => {
      const { chainId } = action.payload

      const lastCheckedBlock = state[chainId]?.lastCheckedBlock

      state[chainId] = {
        ...ORDERS_LIST,
        lastCheckedBlock: lastCheckedBlock ?? ContractDeploymentBlocks[chainId] ?? 0,
      }
    })
    .addCase(updateLastCheckedBlock, (state, action) => {
      prefillState(state, action)
      const { chainId, lastCheckedBlock } = action.payload

      state[chainId].lastCheckedBlock = lastCheckedBlock
    })
    .addCase(setIsOrderUnfillable, (state, action) => {
      prefillState(state, action)
      const { chainId, id, isUnfillable } = action.payload

      const orderObject = getOrderById(state, chainId, id)

      if (orderObject?.order) {
        orderObject.order.isUnfillable = isUnfillable
      }
    })
)
