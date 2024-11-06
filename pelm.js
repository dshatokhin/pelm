import 'npm:zx/globals'
import minimist from 'npm:minimist'
import process from 'npm:process'
import fs from 'npm:fs-extra'
import os from 'npm:os'

const flags = minimist(process.argv.slice(2), {
  boolean: [
    'help',
    'create-namespace'
  ],
  string: [
    'namespace',
    'values'
  ],
  alias: {
    f: 'values',
    n: 'namespace',
    h: 'help'
  },
  default: {
    values: '',
    namespace: ''
  }
})

const action = flags._[0] || 'help'
const releaseName = flags._[1]
let packagePath = flags._[2]

if (fs.existsSync(packagePath) && fs.lstatSync(packagePath).isFile()) {
  const packageTmpPath = tmpdir(releaseName)
  await $`tar xzf ${packagePath} -C ${packageTmpPath}`
  packagePath = packageTmpPath
}

const help = {
  main: `
Usage:
  pelm [command]

Available Commands:
  create      create a new jajarh the given name
  install     install a jar
  package     package a jar directory into a jar archive
  template    locally render templates
  uninstall   uninstall a jar
  values      show the jar's values

Flags:
  --create-namespace       create the release namespace if not present
  -h, --help               help for pelm
  -n, --namespace string   namespace scope for this request
  -f, --values string      specify values in a YAML file
  `
}

const kubeconfigPath = `${os.homedir()}/.kube/config` || process.env.KUBECONFIG

if (!fs.existsSync(kubeconfigPath)) {
  throw 'no kubeconfig'
}

async function template(name, path) {
  const values = (flags.values != '') ? ['-p', `values=${flags.values}`] : ''
  const namespace = (flags.namespace != '') ? ['-p', `namespace=${flags.namespace}`] : ''

  return await $`pkl eval --project-dir ${path} ${path}/renderer.pkl -p name=${name} ${values} ${namespace}`
}

async function create(name) {
  const templates = {
    [`./${name}/PklProject.deps.json`]: `
{
  "schemaVersion": 1,
  "resolvedDependencies": {
    "package://pkg.pkl-lang.org/pkl-pantry/pkl.experimental.deepToTyped@1": {
      "type": "remote",
      "uri": "projectpackage://pkg.pkl-lang.org/pkl-pantry/pkl.experimental.deepToTyped@1.0.2",
      "checksums": {
        "sha256": "0746fe618d59187b15ca3e589caf359a285c74efadd8c796da86aaa08202d542"
      }
    },
    "package://pkg.pkl-lang.org/pkl-k8s/k8s@1": {
      "type": "remote",
      "uri": "projectpackage://pkg.pkl-lang.org/pkl-k8s/k8s@1.1.0",
      "checksums": {
        "sha256": "9ca6002419e405a19b517d506490b46be9279556b5ef2664be0e836df80535e5"
      }
    }
  }
}
`,

    [`./${name}/jar.pkl`]: `
name = "${name}"
description = "A Pelm jar for Kubernetes"

version = "0.1.0"

appVersion = "1.27.1"
`,

    [`./${name}/pelm.pkl`]: `
module Pelm

import "values.pkl" as valuesModule
import "helpers.pkl" as helpersModule
import "jar.pkl" as jarModule

namespace: String = read?("prop:namespace") ?? "default"

values = valuesModule.values
helpers = helpersModule
jar = jarModule
`,

    [`./${name}/renderer.pkl`]: `
module Renderer

import "@k8s/K8sResource.pkl"
import* "templates/[!_]*.pkl" as templates

local resources: Listing<K8sResource> = new {
  for (_item in templates) {
    when (_item.manifest != null) {
      _item.manifest
    }
  }
}

output {
  renderer = (K8sResource.output.renderer as YamlRenderer) { isStream = true }
  value = resources
}
`,

    [`./${name}/templates/deployment.pkl`]: `
import "@k8s/api/apps/v1/Deployment.pkl"
import ".../pelm.pkl"

manifest: Deployment = new {
  metadata {
    name = pelm.helpers.fullname
    namespace = pelm.namespace
    labels = pelm.helpers.labels
  }
  spec {
    when (!pelm.values.autoscaling.enabled) {
      replicas = pelm.values.replicaCount
    }
    selector {
      matchLabels = pelm.helpers.selectorLabels
    }
    template {
      metadata {
        when (!pelm.values.podAnnotations.isEmpty) {
          annotations = pelm.values.podAnnotations
        }
        labels {
          ...pelm.helpers.labels
          ...pelm.values.podLabels
        }
      }
      spec {
        when (!pelm.values.imagePullSecrets.isEmpty) {
          imagePullSecrets = pelm.values.imagePullSecrets
        }
        serviceAccountName = pelm.helpers.serviceAccountName
        securityContext = pelm.values.podSecurityContext
        containers {
          new {
            name = pelm.jar.name
            securityContext = pelm.values.securityContext
            image = "\\(pelm.values.image.repository):\\(pelm.values.image.tag ?? pelm.jar.appVersion)"
            imagePullPolicy = pelm.values.image.pullPolicy
            ports {
              new {
                name = "http"
                containerPort = pelm.values.service.port
                protocol = "TCP"
              }
            }
            livenessProbe = pelm.values.livenessProbe
            readinessProbe = pelm.values.readinessProbe
            resources = pelm.values.resources
            when (!pelm.values.volumeMounts.isEmpty) {
              volumeMounts = pelm.values.volumeMounts
            }
          }
        }
        volumes = pelm.values.volumes
        nodeSelector = pelm.values.nodeSelector
        affinity = pelm.values.affinity
        tolerations = pelm.values.tolerations
      }
    }
  }
}
`,

    [`./${name}/templates/hpa.pkl`]: `
import "@k8s/api/autoscaling/v2/HorizontalPodAutoscaler.pkl"
import ".../pelm.pkl"

manifest: HorizontalPodAutoscaler? = if (pelm.values.autoscaling.enabled) new {
  metadata {
    name = pelm.helpers.fullname
    namespace = pelm.namespace
    labels = pelm.helpers.labels
  }
  spec {
    scaleTargetRef {
      apiVersion = "apps/v1"
      kind = "Deployment"
      name = pelm.helpers.fullname
    }
    minReplicas = pelm.values.autoscaling.minReplicas
    maxReplicas = pelm.values.autoscaling.maxReplicas
    metrics {
      when (pelm.values.autoscaling.targetCPUUtilizationPercentage.isNonZero) {
        new {
          type = "Resource"
          resource {
            name = "cpu"
            target {
              type = "Utilization"
              averageUtilization = pelm.values.autoscaling.targetCPUUtilizationPercentage
            }
          }
        }
      }
      when (pelm.values.autoscaling.targetMemoryUtilizationPercentage.isNonZero) {
        new {
          type = "Resource"
          resource {
            name = "memory"
            target {
              type = "Utilization"
              averageUtilization = pelm.values.autoscaling.targetMemoryUtilizationPercentage
            }
          }
        }
      }
    }
  }
} else null
`,

    [`./${name}/templates/ingress.pkl`]: `
import "@k8s/api/networking/v1/Ingress.pkl"
import ".../pelm.pkl"

manifest: Ingress? = if (pelm.values.ingress.enabled) new {
  metadata {
    name = pelm.helpers.fullname
    namespace = pelm.namespace
    labels = pelm.helpers.labels
    annotations = pelm.values.ingress.annotations
  }
  spec {
    ingressClassName = pelm.values.ingress.className
    when (!pelm.values.ingress.tls.isEmpty) {
      tls = pelm.values.ingress.tls
    }
    rules {
      for (_host in pelm.values.ingress.hosts) {
        new {
          host = _host.host
          http {
            paths {
              for (_path in _host.paths) {
                new {
                  backend {
                    service {
                      name = pelm.helpers.fullname
                      port {
                        number = pelm.values.service.port
                      }
                    }
                  }
                  path = _path.path
                  pathType = _path.pathType
                }
              }
            }
          }
        }
      }
    }
  }
} else null
`,

    [`./${name}/templates/service.pkl`]: `
import "@k8s/api/core/v1/Service.pkl"
import ".../pelm.pkl"

manifest: Service = new {
  metadata {
    name = pelm.helpers.fullname
    namespace = pelm.namespace
    labels = pelm.helpers.labels
  }
  spec {
    type = pelm.values.service.type
    ports {
      new {
        port = pelm.values.service.port
        targetPort = "http"
        protocol = "TCP"
        name = "http"
      }
    }
    selector = pelm.helpers.selectorLabels
  }
}
`,

    [`./${name}/templates/serviceaccount.pkl`]: `
import "@k8s/api/core/v1/ServiceAccount.pkl"
import ".../pelm.pkl"

manifest: ServiceAccount? = if (pelm.values.serviceAccount.create) new {
  metadata {
    name = pelm.helpers.serviceAccountName
    namespace = pelm.namespace
    labels = pelm.helpers.labels
    annotations = pelm.values.serviceAccount.annotations
  }
  automountServiceAccountToken = pelm.values.serviceAccount.automount
} else null
`,

    [`./${name}/values.pkl`]: `
module Values

import "@k8s/api/core/v1/LocalObjectReference.pkl"
import "@k8s/api/core/v1/SecurityContext.pkl"
import "@k8s/api/core/v1/Probe.pkl"
import "@k8s/api/core/v1/ResourceRequirements.pkl"
import "@k8s/api/core/v1/PodSpec.pkl"
import "@k8s/api/core/v1/VolumeMount.pkl"
import "@k8s/api/core/v1/Volume.pkl"
import "@k8s/api/core/v1/Toleration.pkl"
import "@deepToTyped/deepToTyped.pkl"
import "pkl:yaml"

function mapMerge(defaults: Map, overrides: Map) =
  defaults
    .map((k, v) -> (
      if (overrides.containsKey(k))
        if (v is Object && !(v is Listing|List))
          Pair(k, mapMerge(defaults[k].toMap(), overrides[k].toMap()))
        else
          Pair(k, overrides[k])
      else
        Pair(k, v)
      )
    ).toDynamic()

local customValuesProp = read?("prop:values")
local customValuesFile = read?("file:\\(customValuesProp)")
local customValues =
  if (customValuesFile != null)
    new yaml.Parser {}.parse(customValuesFile)
  else
    new Dynamic {}

mergedValues = mapMerge(defaultValues.toMap(), customValues.toMap())
values = deepToTyped.apply(Values, mergedValues)

output {
  renderer = new YamlRenderer {}
  value = defaultValues
}

defaultValues = new Values {
  replicaCount = 1

  image = new {
    repository = "nginx"
    pullPolicy = "IfNotPresent"
    tag = null
  }

  imagePullSecrets = new {}

  nameOverride = null
  fullnameOverride = null

  serviceAccount = new {
    create = true
    automount = true
    annotations = new {}
    name = null
  }

  podAnnotations = new {}
  podLabels = new {}

  podSecurityContext = new {}
  securityContext = new {}

  service = new {
    type = "ClusterIP"
    port = 80
  }

  ingress = new {
    enabled = false
    className = null
    annotations = new {}
    hosts {
      new {
        host = "chart-example.local"
        paths {
          new {
            path = "/"
            pathType = "ImplementationSpecific"
          }
        }
      }
    }
    tls = new {}
  }

  resources = new {}
  livenessProbe = new {
    httpGet {
      path = "/healthy"
      port = "http"
    }
  }

  readinessProbe = new {
    httpGet {
      path = "/ready"
      port = "http"
    }
  }

  autoscaling = new {
    enabled = false
    minReplicas = 1
    maxReplicas = 100
    targetCPUUtilizationPercentage = 80
    targetMemoryUtilizationPercentage = 80
  }

  volumes = new {}
  volumeMounts = new {}

  nodeSelector = new {}
  tolerations = new {}
  affinity = new {}
}

class Values {
  replicaCount: Int?
  image: Image?
  imagePullSecrets: Listing<LocalObjectReference>

  nameOverride: String?
  fullnameOverride: String?

  serviceAccount: ServiceAccount?

  podAnnotations: Mapping<String, String>
  podLabels: Mapping<String, String>

  podSecurityContext: PodSpec.PodSecurityContext
  securityContext: SecurityContext

  service: Service?

  ingress: Ingress?

  resources: ResourceRequirements
  livenessProbe: Probe?
  readinessProbe: Probe?
  autoscaling: Autoscaling?

  volumes: Listing<Volume>
  volumeMounts: Listing<VolumeMount>

  nodeSelector: Mapping<String, String>
  tolerations: Listing<Toleration>
  affinity: PodSpec.Affinity
}

class Image {
  repository: String
  pullPolicy: String
  tag: String?
}

class ServiceAccount {
  create: Boolean
  automount: Boolean
  annotations: Mapping<String, String>
  name: String?
}

class Autoscaling {
  enabled: Boolean
  minReplicas: Int?
  maxReplicas: Int?
  targetCPUUtilizationPercentage: Int?
  targetMemoryUtilizationPercentage: Int?
}

class Service {
  type: String
  port: Int
}

class Ingress {
  enabled: Boolean
  className: String?
  annotations: Mapping<String, String>
  hosts: Listing<Host>
  tls: Listing<TlsCertificate>
}

class Host {
  host: String
  paths: Listing<Path>
}

class Path {
  path: String
  pathType: String
}

class TlsCertificate {
  secretName: String
  hosts: Listing<String>
}
`,

    [`./${name}/PklProject`]: `
amends "pkl:Project"

import "jar.pkl"

package {
  name = jar.name
  baseUri = "package://example.com/\\(jar.name)"
  version = jar.version
  packageZipUrl = "https://example.com/\\(jar.name)/\\(jar.name)@\\(jar.version).zip"
  description = jar.description
}

dependencies {
  ["k8s"] {
    uri = "package://pkg.pkl-lang.org/pkl-k8s/k8s@1.1.0"
  }
  ["deepToTyped"] {
    uri = "package://pkg.pkl-lang.org/pkl-pantry/pkl.experimental.deepToTyped@1.0.2"
  }
}
`,

    [`./${name}/helpers.pkl`]: `
module Helpers

import "values.pkl" as valuesModule
import "jar.pkl" as jarModule

const releaseService: String = "pelm"

releaseName: String = read("prop:name")

values = valuesModule.values
jar = jarModule

name: String = (values.nameOverride ?? jar.name)
  .take(63)
  .dropLastWhile((it) -> it.endsWith("-"))

fullname: String =
  if (values.fullnameOverride != null)
    values.fullnameOverride
      .take(63)
      .dropLastWhile((it) -> it.endsWith("-"))
  else
    if (releaseName.contains(values.nameOverride ?? jar.name))
      releaseName
        .take(63)
        .dropLastWhile((it) -> it.endsWith("-"))
    else
      "\\(releaseName)-\\(name)"

jarFullname: String = "\\(jar.name)-\\(jar.version)"
  .replaceAll("+", "_")
  .take(63)
  .dropLastWhile((it) -> it.endsWith("-"))

selectorLabels: Mapping<String, String> = new {
  ["app.kubernetes.io/name"] = name
  ["app.kubernetes.io/instance"] = releaseName
}

labels: Mapping<String, String> = (selectorLabels) {
  ["pelm.sh/jar"] = jarFullname
  when (!jar.appVersion.isEmpty) {
    ["app.kubernetes.io/version"] = jar.appVersion
  }
  ["app.kubernetes.io/managed-by"] = releaseService
}

serviceAccountName: String =
  if (values.serviceAccount.create)
    values.serviceAccount.name ?? fullname
  else
    values.serviceAccount.name ?? "default"
`
  }

  if (!fs.existsSync(name)) {
    fs.mkdirSync(`${name}/templates`, { recursive: true })
    for (const file in templates) {
      fs.writeFile(file, templates[file])
    }
  }
}

async function tarPackage(name, version, path) {
  const fileName = `${name}-${version}.tgz`
  await $`tar czf ${fileName} -C ${path} .`

  return fileName
}

switch (action) {
  case 'template':
    echo(await template(releaseName, packagePath))
    break

  case 'install':
    if (flags['create-namespace']) {
      await $({ nothrow: true, quiet: true })`kubectl create ns ${flags.namespace}`
    }

    echo(await $({ input: await template(releaseName, packagePath) })`kubectl apply --filename -`)
    break

  case 'uninstall':
    echo(await $({ input: await template(releaseName, packagePath) })`kubectl delete --filename -`)
    break

  case 'values':
    packagePath = flags._[1]

    if (fs.existsSync(packagePath) && fs.lstatSync(packagePath).isFile()) {
      const packageTmpPath = tmpdir(releaseName)
      await $`tar xzf ${packagePath} -C ${packageTmpPath}`
      packagePath = packageTmpPath
    }

    echo(await $`pkl eval --project-dir ${packagePath} ${packagePath}/values.pkl`)
    break

  case 'create':
    const dirName = flags._[1]
    echo(`Creating ${dirName}`)
    await create(dirName)
    break

  case 'package':
    packagePath = flags._[1]

    const packageName = await $`pkl eval --project-dir ${packagePath} ${packagePath}/PklProject --expression package.name`
    const packageVersion = await $`pkl eval --project-dir ${packagePath} ${packagePath}/PklProject --expression package.version`

    echo(await tarPackage(packageName, packageVersion, packagePath))

    break

  case 'help':
    echo(help.main)
    break
}

// vim: ft=javascript
