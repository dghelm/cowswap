import { useWeb3React as useWeb3ReactCore } from '@web3-react/core'
import { useEffect, useState, useCallback } from 'react'
import { isMobile } from 'react-device-detect'
import { injected, walletconnect, getProviderType, WalletProvider } from 'connectors'

// exports from the original file
export { useActiveWeb3React, useInactiveListener } from '@src/hooks/web3'

// last wallet provider key used in local storage
export const STORAGE_KEY_LAST_PROVIDER = 'lastProvider'

export function useEagerConnect() {
  const { activate, active, connector } = useWeb3ReactCore()
  const [tried, setTried] = useState(false)

  // handle setting/removing wallet provider in local storage
  const handleBeforeUnload = useCallback(() => {
    const walletType = getProviderType(connector)

    if (!walletType || !active) {
      localStorage.removeItem(STORAGE_KEY_LAST_PROVIDER)
    } else {
      localStorage.setItem(STORAGE_KEY_LAST_PROVIDER, walletType)
    }
  }, [connector, active])

  useEffect(() => {
    if (!active) {
      const latestProvider = localStorage.getItem(STORAGE_KEY_LAST_PROVIDER)

      // if there is no last saved provider set tried state to true
      if (!latestProvider) {
        setTried(true)
      }

      // check if the last saved provider is Metamask
      if (latestProvider === WalletProvider.INJECTED) {
        // check if the our application is authorized/connected with Metamask
        injected.isAuthorized().then((isAuthorized) => {
          if (isAuthorized) {
            activate(injected, undefined, true).catch(() => {
              setTried(true)
            })
          } else {
            if (isMobile && window.ethereum) {
              activate(injected, undefined, true).catch(() => {
                setTried(true)
              })
            } else {
              setTried(true)
            }
          }
        })
        // check if the last saved provider is WalletConnect
      } else if (latestProvider === WalletProvider.WALLET_CONNECT) {
        activate(walletconnect, undefined, true).catch(() => {
          setTried(true)
        })
      }
    }
  }, [activate, active, connector]) // intentionally only running on mount (make sure it's only mounted once :))

  // if the connection worked, wait until we get confirmation of that to flip the flag
  useEffect(() => {
    if (active) {
      setTried(true)
    }
  }, [active])

  useEffect(() => {
    // add beforeunload event listener on initial component mount
    window.addEventListener('beforeunload', handleBeforeUnload)

    // remove beforeunload event listener on component unmount
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  })

  return tried
}
