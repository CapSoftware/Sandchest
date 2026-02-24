import { isProduction } from "./vpc";

export interface MetricAlarmConfig {
  description: string;
  namespace: string;
  metricName: string;
  statistic: string;
  period: number;
  evaluationPeriods: number;
  threshold: number;
  comparisonOperator: string;
  treatMissingData: string;
}

export function getSnsTopicName(stage: string): string {
  return `sandchest-alarms-${stage}`;
}

// --- ECS alarms ---

export function getEcsRunningTaskAlarm(stage: string): MetricAlarmConfig {
  return {
    description: "ECS running task count below minimum",
    namespace: "AWS/ECS",
    metricName: "RunningTaskCount",
    statistic: "Minimum",
    period: 60,
    evaluationPeriods: 2,
    threshold: isProduction(stage) ? 2 : 1,
    comparisonOperator: "LessThanThreshold",
    treatMissingData: "breaching",
  };
}

export function getEcsCpuAlarm(stage: string): MetricAlarmConfig {
  return {
    description: "ECS service CPU utilization too high",
    namespace: "AWS/ECS",
    metricName: "CPUUtilization",
    statistic: "Average",
    period: 300,
    evaluationPeriods: 3,
    threshold: isProduction(stage) ? 85 : 90,
    comparisonOperator: "GreaterThanThreshold",
    treatMissingData: "notBreaching",
  };
}

export function getEcsMemoryAlarm(stage: string): MetricAlarmConfig {
  return {
    description: "ECS service memory utilization too high",
    namespace: "AWS/ECS",
    metricName: "MemoryUtilization",
    statistic: "Average",
    period: 300,
    evaluationPeriods: 3,
    threshold: isProduction(stage) ? 85 : 90,
    comparisonOperator: "GreaterThanThreshold",
    treatMissingData: "notBreaching",
  };
}

// --- ALB alarms ---

export function getAlb5xxAlarm(stage: string): MetricAlarmConfig {
  return {
    description: "ALB 5xx error count too high",
    namespace: "AWS/ApplicationELB",
    metricName: "HTTPCode_ELB_5XX_Count",
    statistic: "Sum",
    period: 300,
    evaluationPeriods: 2,
    threshold: isProduction(stage) ? 10 : 50,
    comparisonOperator: "GreaterThanThreshold",
    treatMissingData: "notBreaching",
  };
}

export function getAlbResponseTimeAlarm(stage: string): MetricAlarmConfig {
  return {
    description: "ALB target response time too high",
    namespace: "AWS/ApplicationELB",
    metricName: "TargetResponseTime",
    statistic: "Average",
    period: 300,
    evaluationPeriods: 3,
    threshold: isProduction(stage) ? 2 : 5,
    comparisonOperator: "GreaterThanThreshold",
    treatMissingData: "notBreaching",
  };
}

// --- Redis alarms ---

export function getRedisMemoryAlarm(stage: string): MetricAlarmConfig {
  return {
    description: "Redis memory usage percentage too high",
    namespace: "AWS/ElastiCache",
    metricName: "DatabaseMemoryUsagePercentage",
    statistic: "Average",
    period: 300,
    evaluationPeriods: 3,
    threshold: isProduction(stage) ? 80 : 90,
    comparisonOperator: "GreaterThanThreshold",
    treatMissingData: "notBreaching",
  };
}

export function getRedisEvictionAlarm(stage: string): MetricAlarmConfig {
  return {
    description: "Redis evictions detected",
    namespace: "AWS/ElastiCache",
    metricName: "Evictions",
    statistic: "Sum",
    period: 300,
    evaluationPeriods: 2,
    threshold: isProduction(stage) ? 0 : 100,
    comparisonOperator: "GreaterThanThreshold",
    treatMissingData: "notBreaching",
  };
}

// --- Node daemon heartbeat ---

export const NODE_HEARTBEAT_NAMESPACE = "Sandchest/Node";
export const NODE_HEARTBEAT_METRIC = "Heartbeat";

export function getNodeAsgAlarm(): MetricAlarmConfig {
  return {
    description: "Node ASG has no healthy instances",
    namespace: "AWS/AutoScaling",
    metricName: "GroupInServiceInstances",
    statistic: "Minimum",
    period: 60,
    evaluationPeriods: 2,
    threshold: 1,
    comparisonOperator: "LessThanThreshold",
    treatMissingData: "breaching",
  };
}

export function getNodeHeartbeatAlarm(): MetricAlarmConfig {
  return {
    description: "Node daemon heartbeat missing",
    namespace: NODE_HEARTBEAT_NAMESPACE,
    metricName: NODE_HEARTBEAT_METRIC,
    statistic: "SampleCount",
    period: 60,
    evaluationPeriods: 3,
    threshold: 0,
    comparisonOperator: "LessThanOrEqualToThreshold",
    treatMissingData: "breaching",
  };
}
