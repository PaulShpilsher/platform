//
// Copyright © 2020, 2021 Anticrm Platform Contributors.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

/**
 * Plugin architecture and implementation
 * @packageDocumentation
 */

import type { Resource } from '@anticrm/foundation'
import { Status, Severity } from '@anticrm/foundation'

export type { Resource } from '@anticrm/foundation'
export { Status, Severity, PlatformError } from '@anticrm/foundation'

/**
 * Platform Metadata Identifier (PMI).
 *
 * 'Metadata' is simply any JavaScript object, which is used to configure platform, e.g. IP addresses.
 * Another example of metadata is an asset URL. The logic behind providing asset URLs as metadata is
 * we know URL at compile time only and URLs vary depending on deployment options.
 */
export type Metadata<T> = Resource<T> & { __metadata: true }

// P L U G I N S

/** Base interface for a plugin service. */
export interface Service {}

/** Plugin identifier. */
export type Plugin<S extends Service> = Resource<S>
export type AnyPlugin = Plugin<Service>

/** A list of dependencies e.g. `{ core: core.id, ui: ui.id }`. */
export interface PluginDependencies {
  [key: string]: AnyPlugin
}

/**
 * Convert list of dependencies to a list of provided services,
 * e.g. `PluginServices<{core: core.id}> === {core: CoreService}`
 */
export type PluginServices<T extends PluginDependencies> = {
  [P in keyof T]: T[P] extends Plugin<infer Service> ? Service : T[P]
}

/**
 * A Plugin Descriptor, literally plugin ID + dependencies.
 */
export interface PluginDescriptor<S extends Service, D extends PluginDependencies> {
  id: Plugin<S>
  deps: D
}

type AnyDescriptor = PluginDescriptor<Service, PluginDependencies>

type PluginModule<P extends Service, D extends PluginDependencies> = () => Promise<{
  // eslint-disable-next-line no-use-before-define
  default: (platform: Platform, deps: PluginServices<D>) => Promise<P>
}>
type AnyModule = PluginModule<Service, PluginDependencies>

export enum PluginStatus {
  STOPPED,
  RUNNING,
}

export interface PluginInfo {
  id: AnyPlugin
  version: string,
  status: PluginStatus
}

export const PlatformStatus = 'platform-status'

// P L A T F O R M

type ExtractType<T, X extends Record<string, Metadata<T>>> = {
  [P in keyof X]:
  X[P] extends Metadata<infer Z> ? Z : never
}

type EventListener = (event: string, data: any) => Promise<void>

export interface Platform {
  getMetadata<T> (id: Metadata<T>): T | undefined
  setMetadata<T> (id: Metadata<T>, value: T): void
  loadMetadata<T, X extends Record<string, Metadata<T>>> (ids: X, resources: ExtractType<T, X>): void

  addLocation<P extends Service, X extends PluginDependencies> (plugin: PluginDescriptor<P, X>, module: PluginModule<P, X>): void
  resolveDependencies (deps: PluginDependencies): Promise<{ [key: string]: Service }>
  getPlugin<T extends Service> (id: Plugin<T>): Promise<T>
  getRunningPlugin<T extends Service> (id: Plugin<T>): T

  getResource<T> (resource: Resource<T>): Promise<T>
  setResource<T> (resource: Resource<T>, value: T): void
  peekResource<T> (resource: Resource<T>): T | undefined

  addEventListener (event: string, listener: EventListener): void
  removeEventListener (event: string, listener: EventListener): void
  broadcastEvent (event: string, data: any): void

  setPlatformStatus (status: Status): void
}

/*!
 * Anticrm Platform™
 * © 2020, 2021 Anticrm Platform Contributors. All Rights Reserved.
 * Licensed under the Eclipse Public License, Version 2.0
 */
export function createPlatform (): Platform {
  const resources = new Map<Resource<any>, any>()

  // M E T A D A T A

  function getMetadata<T> (id: Metadata<T>): T | undefined {
    return resources.get(id)
  }

  function setMetadata<T> (id: Metadata<T>, value: T): void {
    resources.set(id, value)
  }

  function loadMetadata<T, X extends Record<string, Metadata<T>>> (ids: X, metadata: ExtractType<T, X>): void {
    for (const key in ids) {
      const id = ids[key]
      const resource = metadata[key]
      if (!resource) {
        throw new Error(`no metadata provided, key: ${key}, id: ${id}`)
      }
      resources.set(id, resource)
    }
  }

  // R E S O U R C E S

  const resolvingResources = new Map<Resource<any>, Promise<any>>()

  /** Peek does not resolve resource. Return resource if it's already loaded. */
  function peekResource<T> (resource: Resource<T>): T | undefined {
    return resources.get(resource)
  }

  async function getResource<T> (resource: Resource<T>): Promise<T> {
    const resolved = resources.get(resource)
    if (resolved) {
      return resolved
    } else {
      let resolving = resolvingResources.get(resource)
      if (resolving) {
        return resolving
      }

      resolving = new Promise((resolve, reject) => {
        const info = getResourceInfo(resource)
        getPlugin(info.plugin).then(() => {
          const value = resources.get(resource)
          if (!value) {
            throw new Error('resource not loaded: ' + resource)
          }
          resolve(value)
        }).catch(err => {
          reject(err)
        })
      })

      resolvingResources.set(resource, resolving)
      return resolving
    }
  }

  function setResource<T> (resource: Resource<T>, value: T): void {
    resources.set(resource, value)
  }

  // E V E N T S

  const eventListeners = new Map<string, EventListener[]>()

  function addEventListener (event: string, listener: EventListener) {
    const listeners = eventListeners.get(event)
    if (listeners) {
      listeners.push(listener)
    } else {
      eventListeners.set(event, [listener])
    }
  }

  function removeEventListener (event: string, listener: EventListener) {
    const listeners = eventListeners.get(event)
    if (listeners) {
      listeners.splice(listeners.indexOf(listener), 1)
    }
  }

  function broadcastEvent (event: string, data: any): void {
    const listeners = eventListeners.get(event)
    if (listeners) {
      listeners.forEach(listener => listener(event, data))
    }
  }

  function setPlatformStatus (status: Status | Error | string | unknown) {
    if (typeof status === 'string') {
      broadcastEvent(PlatformStatus, new Status(Severity.INFO, 0, status))
    } else if (status instanceof Error) {
      const err = status as Error
      broadcastEvent(PlatformStatus, new Status(Severity.ERROR, 0, err.message))
    } else if (status instanceof Status) {
      broadcastEvent(PlatformStatus, status)
    } else {
      broadcastEvent(PlatformStatus, new Status(Severity.WARNING, 0, 'Unknown status: ' + status))
    }
  }

  function createMonitor<T> (name: string, promise: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      setPlatformStatus(name)
      promise.then(result => {
        setPlatformStatus(new Status(Severity.OK, 0, ''))
        resolve(result)
      }).catch(error => {
        setPlatformStatus(error)
        reject(error)
      })
    })
  }

  // P L U G I N S

  const plugins = new Map<AnyPlugin, Promise<Service>>()
  const locations = [] as [AnyDescriptor, AnyModule][]
  const running = new Map<AnyPlugin, Service>()

  function getLocation (id: AnyPlugin): [AnyDescriptor, AnyModule] {
    for (const location of locations) {
      if (location[0].id === id) {
        return location
      }
    }
    throw new Error('no location provided for plugin: ' + id)
  }

  function addLocation<P extends Service, X extends PluginDependencies>
  (plugin: PluginDescriptor<P, X>, module: PluginModule<P, X>) {
    locations.push([plugin, module as any])
  }

  async function getPlugin<T extends Service> (id: Plugin<T>): Promise<T> {
    const plugin = plugins.get(id)
    if (plugin) {
      return plugin as Promise<T>
    } else {
      const location = getLocation(id)
      const plugin = resolveDependencies(location[0].deps).then(deps =>
        createMonitor(`Загружаю плагин '${id}...'`, location[1]())
          .then(module => module.default)
          .then(f => {
            const service = f(platform, deps)
            service.then(s => running.set(id, s))
            return service
          })
      )
      plugins.set(id, plugin)
      return plugin as Promise<T>
    }
  }

  function getRunningPlugin<T extends Service> (id: Plugin<T>): T {
    const service = running.get(id)
    if (service) return service as T
    throw new Error('plugin not running: ' + id)
  }

  async function resolveDependencies (deps: PluginDependencies): Promise<{ [key: string]: Service }> {
    const result = {} as { [key: string]: Service }
    for (const key in deps) {
      const id = deps[key]
      result[key] = await getPlugin(id)
    }
    return result
  }

  const platform = {
    getMetadata,
    setMetadata,
    loadMetadata,

    addLocation,
    resolveDependencies,
    getPlugin,
    getRunningPlugin,

    getResource,
    setResource,
    peekResource,

    addEventListener,
    removeEventListener,
    broadcastEvent,

    setPlatformStatus
  }

  return platform
}

// I D E N T I T Y

type Namespace = Record<string, Record<string, any>>

function transform<N extends Namespace> (plugin: AnyPlugin, namespaces: N, f: (id: string, value: any) => any): N {
  const result = {} as Namespace
  for (const namespace in namespaces) {
    const extensions = namespaces[namespace]
    const transformed = {} as Record<string, any>
    for (const key in extensions) {
      transformed[key] = f(namespace + ':' + plugin + '.' + key, extensions[key])
    }
    result[namespace] = transformed
  }
  return result as N
}

export function identify<N extends Namespace> (pluginId: AnyPlugin, namespace: N): N {
  return transform(pluginId, namespace, (id: string, value) => value === '' ? id : value)
}

export function plugin<P extends Service, D extends PluginDependencies, N extends Namespace> (id: Plugin<P>, deps: D, namespace: N): PluginDescriptor<P, D> & N {
  return {
    id,
    deps,
    ...identify(id, namespace)
  }
}

// R E S O U R C E  I N F O

export type ResourceKind = string & { __resourceKind: true }

export interface ResourceInfo {
  kind: ResourceKind
  plugin: Plugin<Service>
  id: string
}

export function getResourceInfo (resource: Resource<any>): ResourceInfo {
  const index = resource.indexOf(':')
  if (index === -1) {
    throw new Error('invalid resource id format')
  }
  const kind = resource.substring(0, index) as ResourceKind
  const dot = resource.indexOf('.', index)
  const plugin = resource.substring(index + 1, dot) as AnyPlugin
  const id = resource.substring(dot)
  return {
    kind,
    plugin,
    id
  }
}
